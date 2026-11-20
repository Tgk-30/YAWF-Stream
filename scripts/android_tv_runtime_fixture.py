#!/usr/bin/env python3
"""Generate and serve a secret-free Android TV native-player fixture.

This is deliberately a native-bridge fixture, not a claim that the production
EmbeddedPlayer route was exercised. The page is loaded through MainActivity's
normal Connect flow and invokes only the product's documented
YawfAndroidTV.play/stop surface.
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from io import BytesIO
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

TOKEN = "Bearer yawf-tv-runtime-public-fixture"
MAX_LOG_ENTRIES = 4096

TV_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YAWF TV native bridge runtime fixture</title>
<style>
body{background:#111;color:#fff;font:32px sans-serif;margin:5vh 8vw}button{display:block;font:inherit;margin:24px 0;padding:20px 32px}.status{color:#ffd166}
</style></head><body>
<h1>YAWF TV native bridge runtime fixture</h1>
<p>Test-only same-origin fixture. No provider account is used.</p>
<button id="play">Play 4:3 HLS fixture</button>
<button id="error">Play missing HLS fixture</button>
<button id="stop">Stop native player</button>
<p id="status" class="status" role="status">Ready for native playback</p>
<script>
const status=document.getElementById('status');
const payload=(url)=>JSON.stringify({url,contentType:'application/vnd.apple.mpegurl',
 title:'YAWF Android TV 4:3 runtime fixture',sourceFileName:'fixture-master.m3u8',
 authorization:'Bearer yawf-tv-runtime-public-fixture',audioLanguage:'fr',
 subtitleLanguage:'en',subtitlesEnabled:false,startPositionSeconds:0});
function play(path){if(!window.YawfAndroidTV){status.textContent='Native bridge unavailable';return}
 status.textContent='Opening native player';window.YawfAndroidTV.play(payload(location.origin+path));}
document.getElementById('play').onclick=()=>play('/media/master.m3u8');
document.getElementById('error').onclick=()=>play('/media/missing.m3u8');
document.getElementById('stop').onclick=()=>window.YawfAndroidTV&&window.YawfAndroidTV.stop();
window.addEventListener('yawf-android-tv-progress',e=>status.textContent='Progress '+Number(e.detail.positionSeconds||0).toFixed(1)+' seconds');
window.addEventListener('yawf-android-tv-closed',e=>status.textContent='Native player closed at '+Number(e.detail.positionSeconds||0).toFixed(1)+' seconds');
window.addEventListener('yawf-android-tv-error',()=>status.textContent='Native playback error received');
</script></body></html>"""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str]) -> None:
    completed = subprocess.run(command, text=True, capture_output=True, timeout=180)
    if completed.returncode:
        tail = (completed.stderr or completed.stdout)[-4000:]
        raise RuntimeError(f"fixture command failed ({completed.returncode}): {tail}")


def generate(root: Path, ffmpeg: str, ffprobe: str) -> dict[str, object]:
    root = root.resolve()
    media = root / "media"
    media.mkdir(parents=True, exist_ok=True)
    (root / "tv.html").write_text(TV_HTML, encoding="utf-8")

    run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=24",
        "-t", "90", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-profile:v", "main", "-preset", "veryfast", "-g", "48",
        "-keyint_min", "48", "-sc_threshold", "0", "-b:v", "900k",
        "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-hls_segment_filename", str(media / "video-%03d.ts"),
        str(media / "video.m3u8"),
    ])
    for language, frequency in (("fr", "880"), ("en", "440")):
        run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000",
            "-t", "90", "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
            "-hls_segment_filename", str(media / f"audio-{language}-%03d.ts"),
            str(media / f"audio-{language}.m3u8"),
        ])

    (media / "subtitles-en.vtt").write_text(
        "WEBVTT\n\n00:00:01.000 --> 00:00:08.000\nEnglish test subtitle\n\n"
        "00:00:30.000 --> 00:00:38.000\nSeek target subtitle\n",
        encoding="utf-8",
    )
    (media / "subtitles-en.m3u8").write_text(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:90\n"
        "#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:90.000,\nsubtitles-en.vtt\n#EXT-X-ENDLIST\n",
        encoding="utf-8",
    )
    (media / "master.m3u8").write_text(
        "#EXTM3U\n#EXT-X-VERSION:3\n"
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES,URI="audio-fr.m3u8"\n'
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="audio-en.m3u8"\n'
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English subtitles",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subtitles-en.m3u8"\n'
        '#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1050000,RESOLUTION=640x480,FRAME-RATE=24.000,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"\n'
        "video.m3u8\n",
        encoding="utf-8",
    )
    probe = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "stream=index,codec_name,codec_type,width,height", "-of", "json", str(media / "master.m3u8")],
        text=True, capture_output=True, timeout=60,
    )
    if probe.returncode:
        raise RuntimeError("ffprobe could not read generated master playlist")
    files = sorted(path for path in root.rglob("*") if path.is_file())
    receipt = {
        "schemaVersion": 1,
        "durationSeconds": 90,
        "video": {"codec": "h264", "width": 640, "height": 480, "aspectRatio": "4:3"},
        "audio": {"default": "fr", "tracks": ["fr", "en"], "syntheticTonesHz": {"fr": 880, "en": 440}},
        "subtitles": ["en"],
        "nativeBridgeFixture": True,
        "productionEmbeddedPlayerRoute": False,
        "files": {str(path.relative_to(root)): {"size": path.stat().st_size, "sha256": sha256(path)} for path in files},
        "ffprobe": json.loads(probe.stdout),
    }
    (root / "fixture-generation.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


class FixtureState:
    def __init__(self, root: Path, log_path: Path):
        self.root = root.resolve()
        self.log_path = log_path.resolve()
        self.lock = threading.Lock()
        self.events: list[dict[str, object]] = []

    def record(self, path: str, authorized: bool, byte_range: bool) -> None:
        event = {"sequence": len(self.events) + 1, "path": path, "authorized": authorized, "range": byte_range}
        with self.lock:
            if len(self.events) >= MAX_LOG_ENTRIES:
                raise RuntimeError("fixture request log bound exceeded")
            self.events.append(event)
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(event, sort_keys=True) + "\n")

    def audit(self) -> dict[str, object]:
        with self.lock:
            events = list(self.events)
        return {
            "schemaVersion": 1,
            "requests": events,
            "authorizationValuesPersisted": False,
            "nativeBridgeFixture": True,
        }


def safe_media_path(root: Path, url_path: str) -> Path | None:
    decoded = PurePosixPath(url_path)
    if not url_path.startswith("/media/") or ".." in decoded.parts:
        return None
    candidate = (root / url_path.removeprefix("/")).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def handler_for(state: FixtureState):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "YawfTvRuntimeFixture/1"

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            if self.path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path in ("/tv", "/tv/"):
                return self.send_file(state.root / "tv.html", "text/html; charset=utf-8", require_auth=False)
            if path == "/__audit":
                body = json.dumps(state.audit(), sort_keys=True).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            target = safe_media_path(state.root, path)
            authorized = self.headers.get("Authorization") == TOKEN
            state.record(path, authorized, self.headers.get("Range") is not None)
            if not authorized:
                self.send_error(401)
                return
            if target is None or not target.is_file():
                self.send_error(404)
                return
            media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix == ".m3u8":
                media_type = "application/vnd.apple.mpegurl"
            self.send_file(target, media_type, require_auth=True)

        def send_file(self, path: Path, media_type: str, *, require_auth: bool) -> None:
            if require_auth and self.headers.get("Authorization") != TOKEN:
                self.send_error(401)
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", media_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def serve(root: Path, host: str, port: int, ready_file: Path, log_path: Path) -> None:
    if host not in {"127.0.0.1", "::1"}:
        raise ValueError("fixture must bind loopback only")
    state = FixtureState(root, log_path)
    server = http.server.ThreadingHTTPServer((host, port), handler_for(state))
    ready_file.parent.mkdir(parents=True, exist_ok=True)
    ready_file.write_text(json.dumps({"host": host, "port": port, "pid": os.getpid()}) + "\n")
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


class FixturePolicyTests(unittest.TestCase):
    @staticmethod
    def memory_handler(state: FixtureState, path: str, headers: dict[str, str] | None = None):
        base = handler_for(state)

        class MemoryHandler(base):
            def __init__(self) -> None:
                self.path = path
                self.headers = headers or {}
                self.wfile = BytesIO()
                self.status: int | None = None
                self.response_headers: dict[str, str] = {}

            def send_response(self, code: int, _message: str | None = None) -> None:
                self.status = code

            def send_header(self, keyword: str, value: str) -> None:
                self.response_headers[keyword] = value

            def end_headers(self) -> None:
                return

            def send_error(
                    self,
                    code: int,
                    _message: str | None = None,
                    _explain: str | None = None) -> None:
                self.status = code

        return MemoryHandler()

    def test_path_stays_under_media(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertEqual(safe_media_path(root, "/media/master.m3u8"), root / "media/master.m3u8")
            self.assertIsNone(safe_media_path(root, "/media/../secret"))
            self.assertIsNone(safe_media_path(root, "/tv"))

    def test_exact_favicon_is_empty_204_before_media_audit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            log_path = root / "requests.jsonl"
            state = FixtureState(root, log_path)
            handler = self.memory_handler(state, "/favicon.ico")

            handler.do_GET()

            self.assertEqual(handler.status, 204)
            self.assertEqual(handler.response_headers.get("Content-Length"), "0")
            self.assertEqual(handler.wfile.getvalue(), b"")
            self.assertEqual(state.events, [])
            self.assertFalse(log_path.exists())

            near_match = self.memory_handler(state, "/favicon.ico?unexpected=1")
            near_match.do_GET()
            self.assertEqual(near_match.status, 401)
            self.assertEqual(
                state.events,
                [{"sequence": 1, "path": "/favicon.ico", "authorized": False, "range": False}],
            )

    def test_media_authorization_and_known_assets_remain_guarded(self) -> None:
        from android_tv_runtime_check import GateError, validate_fixture_audit

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "media").mkdir()
            media = root / "media/master.m3u8"
            media.write_bytes(b"#EXTM3U\n")
            (root / "tv.html").write_text(TV_HTML, encoding="utf-8")

            rejected_state = FixtureState(root, root / "rejected.jsonl")
            rejected = self.memory_handler(rejected_state, "/media/master.m3u8")
            rejected.do_GET()
            self.assertEqual(rejected.status, 401)
            self.assertEqual(
                rejected_state.events,
                [{"sequence": 1, "path": "/media/master.m3u8", "authorized": False, "range": False}],
            )
            with self.assertRaises(GateError):
                validate_fixture_audit(rejected_state.audit())

            accepted_state = FixtureState(root, root / "accepted.jsonl")
            accepted = self.memory_handler(
                accepted_state,
                "/media/master.m3u8",
                {"Authorization": TOKEN},
            )
            accepted.do_GET()
            self.assertEqual(accepted.status, 200)
            self.assertEqual(accepted.wfile.getvalue(), b"#EXTM3U\n")
            self.assertEqual(
                accepted_state.events,
                [{"sequence": 1, "path": "/media/master.m3u8", "authorized": True, "range": False}],
            )

            guarded = self.memory_handler(accepted_state, "/direct-send-file-guard")
            guarded.send_file(media, "application/vnd.apple.mpegurl", require_auth=True)
            self.assertEqual(guarded.status, 401)
            self.assertEqual(guarded.wfile.getvalue(), b"")

            page = self.memory_handler(accepted_state, "/tv")
            page.do_GET()
            self.assertEqual(page.status, 200)
            self.assertIn(b"YAWF TV native bridge runtime fixture", page.wfile.getvalue())
            self.assertEqual(len(accepted_state.events), 1)

    def test_page_uses_exact_bounded_bridge_contract(self) -> None:
        self.assertIn("window.YawfAndroidTV.play", TV_HTML)
        self.assertIn("sourceFileName:'fixture-master.m3u8'", TV_HTML)
        self.assertIn("audioLanguage:'fr'", TV_HTML)
        self.assertIn("subtitlesEnabled:false", TV_HTML)
        self.assertNotIn("fetch(", TV_HTML)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("generate")
    make.add_argument("--output", type=Path, required=True)
    make.add_argument("--ffmpeg", default="ffmpeg")
    make.add_argument("--ffprobe", default="ffprobe")
    host = sub.add_parser("serve")
    host.add_argument("--root", type=Path, required=True)
    host.add_argument("--host", default="127.0.0.1")
    host.add_argument("--port", type=int, default=4190)
    host.add_argument("--ready-file", type=Path, required=True)
    host.add_argument("--request-log", type=Path, required=True)
    sub.add_parser("self-test")
    args = parser.parse_args()
    if args.command == "generate":
        print(json.dumps(generate(args.output, args.ffmpeg, args.ffprobe), sort_keys=True))
    elif args.command == "serve":
        serve(args.root, args.host, args.port, args.ready_file, args.request_log)
    else:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(FixturePolicyTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
