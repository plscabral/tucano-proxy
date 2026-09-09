#!/usr/bin/env python3
"""Exercise a running Tucano proxy against a finite local HTTP workload.

No external network, certificate installation or OS proxy changes are performed.
Run a disposable Tucano session first. Use --direct for a separate baseline run.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import platform
import statistics
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proxy-port', type=int, default=8888)
    parser.add_argument('--requests', type=int, default=1000)
    parser.add_argument('--concurrency', type=int, default=8)
    parser.add_argument('--body-bytes', type=int, default=1024)
    parser.add_argument('--direct', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.requests <= 1_000_000 or not 1 <= args.concurrency <= 256:
        parser.error('requests must be 1..1000000 and concurrency 1..256')
    if not 0 <= args.body_bytes <= 64 * 1024 * 1024:
        parser.error('body-bytes must be 0..67108864')
    payload = b'x' * args.body_bytes

    class Origin(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
    thread = threading.Thread(target=origin.serve_forever, daemon=True)
    thread.start()
    port = origin.server_address[1]

    def request(index):
        connection = HTTPConnection('127.0.0.1', port if args.direct else args.proxy_port, timeout=30)
        path = f'/benchmark/{index}'
        target = path if args.direct else f'http://127.0.0.1:{port}{path}'
        started = time.perf_counter()
        try:
            connection.request('GET', target)
            response = connection.getresponse()
            body = response.read()
            if response.status != 200 or body != payload:
                raise RuntimeError(f'request {index}: status={response.status}, bytes={len(body)}; forwarded content differs')
            return (time.perf_counter() - started) * 1000
        finally:
            connection.close()

    try:
        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            latencies = list(pool.map(request, range(args.requests)))
        duration = time.perf_counter() - started
    finally:
        origin.shutdown()
        origin.server_close()
        thread.join(timeout=5)
    ordered = sorted(latencies)

    def percentile(fraction):
        return ordered[min(len(ordered) - 1, max(0, int((len(ordered) - 1) * fraction)))]

    result = {
        'mode': 'direct' if args.direct else 'proxy',
        'platform': platform.platform(),
        'python': platform.python_version(),
        'requests': args.requests,
        'concurrency': args.concurrency,
        'responseBytes': args.body_bytes,
        'elapsedSeconds': round(duration, 3),
        'requestsPerSecond': round(args.requests / duration, 2),
        'latencyMs': {
            'mean': round(statistics.mean(latencies), 3),
            'p50': round(percentile(0.50), 3),
            'p95': round(percentile(0.95), 3),
            'p99': round(percentile(0.99), 3),
            'max': round(max(latencies), 3),
        },
        'forwardedBodiesVerified': True,
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{result['mode']}: {args.requests} requests, concurrency {args.concurrency}, {args.body_bytes} bytes/response")
        print(f"{result['requestsPerSecond']} requests/s in {result['elapsedSeconds']}s")
        print('Latency (ms): ' + ', '.join(f'{key}={value}' for key, value in result['latencyMs'].items()))
        print('All forwarded response bodies matched the origin.')


if __name__ == '__main__':
    main()
