from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, TypeVar

import spotipy
from dotenv import load_dotenv
from spotipy.exceptions import SpotifyException
from spotipy.oauth2 import SpotifyOAuth


STATE_FILE = ".spotify-import-state.json"
NOT_FOUND_FILE = "not_found.txt"
SAVED_BATCH_SIZE = 40
SPOTIFY_SEARCH_QUERY_MAX_LENGTH = 240
T = TypeVar("T")


@dataclass(frozen=True)
class Track:
    artist: str
    title: str

    @property
    def label(self) -> str:
        return f"{self.artist} – {self.title}"

    @property
    def key(self) -> str:
        return f"{normalise(self.artist)}\u001f{normalise(self.title)}"


def normalise(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    value = "".join(char for char in value if not unicodedata.combining(char))
    value = re.sub(r"[^\w\s]", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def read_tracks(path: Path, keep_order: bool) -> list[Track]:
    if not path.is_file():
        raise SystemExit(f"Файл не найден: {path}")

    tracks: list[Track] = []
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip().replace("–", "-").replace("—", "-")
        if " - " not in line:
            continue
        artist, title = (part.strip() for part in line.split(" - ", 1))
        if not artist or not title:
            continue
        track = Track(artist, title)
        if track.key not in seen:
            tracks.append(track)
            seen.add(track.key)

    if not keep_order:
        tracks.reverse()
    return tracks


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "tracks": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data.get("tracks"), dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    raise SystemExit(f"Не удалось прочитать файл прогресса {path}. Удалите его или укажите --reset-state.")


def save_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def create_client() -> spotipy.Spotify:
    env_path = Path(__file__).with_name(".env")
    load_dotenv(env_path)
    required = ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI")
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise SystemExit(f"Заполните {', '.join(missing)} в {env_path}.")

    return spotipy.Spotify(auth_manager=SpotifyOAuth(
        client_id=os.environ["SPOTIFY_CLIENT_ID"],
        client_secret=os.environ["SPOTIFY_CLIENT_SECRET"],
        redirect_uri=os.environ["SPOTIFY_REDIRECT_URI"],
        scope="user-library-modify",
        cache_path=str(Path(__file__).with_name(".cache")),
    ))


def with_rate_limit_retry(action: Callable[[], T], description: str) -> T:
    transient_attempts = 0
    while True:
        try:
            return action()
        except SpotifyException as error:
            if error.http_status == 429:
                headers = error.headers or {}
                wait_seconds = max(1, int(headers.get("Retry-After", "5")))
                print(f"Лимит Spotify для «{description}». Жду {wait_seconds} сек. и продолжаю…")
                time.sleep(wait_seconds)
                continue
            if error.http_status and 500 <= error.http_status < 600 and transient_attempts < 5:
                transient_attempts += 1
                wait_seconds = 2 ** transient_attempts
                print(f"Spotify временно недоступен. Повтор через {wait_seconds} сек…")
                time.sleep(wait_seconds)
                continue
            raise


def similarity(left: str, right: str) -> float:
    return SequenceMatcher(None, normalise(left), normalise(right)).ratio()


def query_fragment(value: str, maximum: int) -> str:
    value = value.replace('"', " ").replace("\n", " ").replace("\r", " ")
    value = " ".join(value.split())
    if len(value) <= maximum:
        return value

    shortened = value[:maximum].rsplit(" ", 1)[0].strip()
    return shortened or value[:maximum]


def build_search_query(track: Track) -> str:
    artist = query_fragment(track.artist, 90)
    title = query_fragment(track.title, 130)
    query = f'track:"{title}" artist:"{artist}"'
    if len(query) <= SPOTIFY_SEARCH_QUERY_MAX_LENGTH:
        return query


    available = SPOTIFY_SEARCH_QUERY_MAX_LENGTH - len('track:"" artist:""')
    artist_limit = max(20, available // 3)
    title_limit = max(20, available - artist_limit)
    return f'track:"{query_fragment(track.title, title_limit)}" artist:"{query_fragment(track.artist, artist_limit)}"'


def choose_match(track: Track, items: list[dict[str, Any]]) -> dict[str, Any] | None:
    best_item: dict[str, Any] | None = None
    best_score = 0.0
    for item in items:
        title_score = similarity(track.title, item.get("name", ""))
        artist_names = ", ".join(artist.get("name", "") for artist in item.get("artists", []))
        artist_score = similarity(track.artist, artist_names)
        score = title_score * 0.72 + artist_score * 0.28
        if score > best_score:
            best_item, best_score = item, score


    if best_item and best_score >= 0.70:
        return best_item
    return None


def resolve_track(client: spotipy.Spotify, track: Track) -> dict[str, Any] | None:
    query = build_search_query(track)
    result = with_rate_limit_retry(
        lambda: client.search(q=query, type="track", limit=10),
        f"поиск: {track.label}",
    )
    return choose_match(track, result.get("tracks", {}).get("items", []))


def save_uris(client: spotipy.Spotify, uris: list[str]) -> None:
    with_rate_limit_retry(
        lambda: client._put("me/library", args={"uris": ",".join(uris)}),
        f"сохранение {len(uris)} треков",
    )


def write_not_found(path: Path, state: dict[str, Any]) -> None:
    missing = [
        item["label"]
        for item in state["tracks"].values()
        if item.get("status") == "not_found"
    ]
    path.write_text("\n".join(missing) + ("\n" if missing else ""), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Импорт треков в Spotify с сохранением прогресса.")
    parser.add_argument("--input", default="tracks.txt", help="Путь к tracks.txt")
    parser.add_argument("--keep-order", action="store_true", help="Не переворачивать исходный порядок")
    parser.add_argument("--state", default=STATE_FILE, help="Файл кеша и прогресса")
    parser.add_argument("--reset-state", action="store_true", help="Удалить сохранённый прогресс перед запуском")
    parser.add_argument("--resolve-only", action="store_true", help="Только найти треки, не добавляя их в библиотеку")
    args = parser.parse_args()

    input_path = Path(args.input)
    state_path = Path(args.state)
    if args.reset_state and state_path.exists():
        state_path.unlink()

    tracks = read_tracks(input_path, args.keep_order)
    if not tracks:
        raise SystemExit("В tracks.txt не найдено строк формата «Исполнитель – Название». ")

    state = load_state(state_path)
    state["source_sha256"] = hashlib.sha256(input_path.read_bytes()).hexdigest()
    entries: dict[str, dict[str, Any]] = state["tracks"]
    for track in tracks:
        entries.setdefault(track.key, {"artist": track.artist, "title": track.title, "label": track.label, "status": "pending"})
    save_state(state_path, state)

    client = create_client()
    pending = [track for track in tracks if entries[track.key].get("status") == "pending"]
    print(f"Всего уникальных треков: {len(tracks)}. Осталось найти: {len(pending)}.")

    for index, track in enumerate(pending, 1):
        print(f"[{index}/{len(pending)}] Ищу: {track.label}")
        item = resolve_track(client, track)
        if item:
            entries[track.key].update({"status": "matched", "uri": item["uri"], "spotify_name": item["name"]})
            print("  ✓ Найден")
        else:
            entries[track.key]["status"] = "not_found"
            print("  ✗ Не найден")
        save_state(state_path, state)

    write_not_found(Path(NOT_FOUND_FILE), state)
    if args.resolve_only:
        print("Поиск завершён. Добавление в библиотеку отключено параметром --resolve-only.")
        return

    unsaved = [item for item in entries.values() if item.get("status") == "matched"]
    print(f"Найдено для добавления: {len(unsaved)}.")
    for start in range(0, len(unsaved), SAVED_BATCH_SIZE):
        batch = unsaved[start:start + SAVED_BATCH_SIZE]
        save_uris(client, [item["uri"] for item in batch])
        for item in batch:
            item["status"] = "saved"
        save_state(state_path, state)
        print(f"Добавлено в библиотеку: {min(start + len(batch), len(unsaved))}/{len(unsaved)}")

    saved_count = sum(item.get("status") == "saved" for item in entries.values())
    missing_count = sum(item.get("status") == "not_found" for item in entries.values())
    print(f"Готово. В библиотеке: {saved_count}; не найдено: {missing_count} ({NOT_FOUND_FILE}).")


if __name__ == "__main__":
    main()
