"""One JSON line per completed query; errors leave the query unmeasured."""
import json
import sys
import time


def main():
    from pytrends.request import TrendReq
    config = json.load(sys.stdin)
    country = config['country'].upper()
    client = TrendReq(hl='es-MX' if country == 'MX' else 'en-US', tz=360)
    original = client._get_data
    last = [0.0]

    def throttled(*args, **kwargs):
        delay = 8 - (time.monotonic() - last[0])
        if delay > 0:
            time.sleep(delay)
        last[0] = time.monotonic()
        return original(*args, **kwargs)

    client._get_data = throttled
    for query in config['queries']:
        try:
            client.build_payload([query], timeframe='today 12-m', geo=country)
            frame = client.interest_over_time()
            if query not in frame or frame.empty:
                continue
            values = [float(x) for x in frame[query].tolist()]
            avg = sum(values) / len(values)
            recent = sum(values[-8:]) / len(values[-8:])
            slope = 'up' if recent > avg * 1.1 else 'down' if recent < avg * 0.9 else 'flat'
            related = client.related_queries().get(query, {})

            def names(kind):
                table = related.get(kind)
                return [] if table is None or 'query' not in table else [str(x) for x in table['query'].tolist()]

            data = {'mean': round(avg, 2), 'last8Mean': round(recent, 2), 'slope': slope, 'rising': names('rising'), 'top': names('top')}
            print(json.dumps({'query': query, 'data': data}, ensure_ascii=False), flush=True)
        except Exception as exc:
            if '429' in str(exc) or exc.__class__.__name__ == 'TooManyRequestsError':
                break
            continue


if __name__ == '__main__':
    main()
