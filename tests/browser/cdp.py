"""Minimal Chrome DevTools Protocol client — stdlib only.

Just enough WebSocket to drive a page: masked text frames out,
unfragmented frames in. No deps, matching the repo's no-npm stance.
"""
import base64, json, os, socket, struct, subprocess, time, urllib.request


def http_json(port, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


class WS:
    def __init__(self, url):
        # ws://127.0.0.1:PORT/devtools/page/ID
        rest = url[len("ws://"):]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        if b"101" not in buf.split(b"\r\n")[0]:
            raise RuntimeError("websocket upgrade failed: " + buf[:200].decode("latin1"))
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.msg_id = 0
        self.events = []

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, method, params=None, session=None):
        self.msg_id += 1
        msg = {"id": self.msg_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        data = json.dumps(msg).encode()
        header = b"\x81"
        n = len(data)
        if n < 126:
            header += struct.pack("!B", n | 0x80)
        elif n < 65536:
            header += struct.pack("!BH", 126 | 0x80, n)
        else:
            header += struct.pack("!BQ", 127 | 0x80, n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)
        return self.msg_id

    def _read_frame(self):
        """Read one full message, reassembling continuation frames.

        Chrome fragments large payloads (a screenshot response is hundreds
        of KB). Ignoring the FIN bit desynchronises the stream: the tail of
        a fragment gets read as the next frame header, and every later read
        is garbage — which shows up as an inexplicable hang, not an error.
        """
        payload = b""
        while True:
            b0, b1 = self._recv(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv(8))[0]
            mask = self._recv(4) if masked else None
            data = self._recv(length) if length else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))

            if opcode == 0x8:
                raise RuntimeError("websocket closed by peer")
            if opcode == 0x9:                      # ping -> pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0xA:                      # pong
                continue
            payload = data if opcode in (0x1, 0x2) else payload + data
            if fin:
                return payload

    def call(self, method, params=None, session=None, timeout=60):
        want = self.send(method, params, session)
        deadline = time.time() + timeout
        while time.time() < deadline:
            frame = self._read_frame()
            if frame is None:
                continue
            msg = json.loads(frame)
            if msg.get("id") == want:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)
        raise TimeoutError(method)

    def drain(self, seconds=0.4):
        self.sock.settimeout(seconds)
        try:
            while True:
                frame = self._read_frame()
                if frame is None:
                    continue
                msg = json.loads(frame)
                if "method" in msg:
                    self.events.append(msg)
        except (socket.timeout, TimeoutError, OSError):
            pass
        finally:
            self.sock.settimeout(60)


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def launch(url, port, profile, headless=True):
    args = [
        CHROME,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        "--window-size=1440,900",
    ]
    if headless:
        args.append("--headless=new")
    args.append(url)
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            http_json(port, "/json/version")
            return proc
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("chrome did not expose the debugging port")


def page_target(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for t in http_json(port, "/json/list"):
            if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                return t
        time.sleep(0.2)
    raise RuntimeError("no page target")
