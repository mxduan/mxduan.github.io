"""Official-source cache. No visitor makes a request to MTA."""
import json
import sys
import hashlib
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from google.transit import gtfs_realtime_pb2

NY = ZoneInfo('America/New_York')
ROOT = Path(__file__).resolve().parents[1]
ALERTS = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts'
ARCHIVE = 'https://data.ny.gov/resource/7kct-peq7.json'
PERFORMANCE = 'https://data.ny.gov/resource/r7qk-6tcy.json'
DELAYS = {'delays', 'some-delays', 'severe-delays', 'delays-and-cancellations'}

def iso(dt): return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
def tokens(value): return {x.strip() for x in value.split('|')}
def local_date(value):
    # Socrata floating timestamps represent local New York publication times.
    return datetime.fromisoformat(value).replace(tzinfo=NY)
def monday(dt): return dt.date() - timedelta(days=dt.weekday())

def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'RailReliability/1.0 (official data cache)'}), timeout=45) as response:
        return response.read()
def query(url, params): return json.loads(fetch(url + '?' + urlencode(params)))

def fields(data):
    """Read protobuf wire fields for the MTA Mercury extension (official field 1001)."""
    pos = 0
    def varint():
        nonlocal pos
        out = shift = 0
        while pos < len(data) and shift < 70:
            byte = data[pos]; pos += 1; out |= (byte & 127) << shift
            if not byte & 128: return out
            shift += 7
        raise ValueError('Invalid protobuf varint')
    result = {}
    while pos < len(data):
        tag = varint(); number, wire = tag >> 3, tag & 7
        if wire == 0: value = varint()
        elif wire == 2:
            size = varint(); value = data[pos:pos+size]; pos += size
            if pos > len(data): raise ValueError('Truncated protobuf field')
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4; value = data[pos:pos+size]; pos += size
            if pos > len(data): raise ValueError('Truncated protobuf field')
        else: raise ValueError('Unsupported protobuf wire type')
        result.setdefault(number, []).append(value)
    return result

def mercury(message):
    values = fields(message.SerializeToString()).get(1001, [])
    return fields(values[0]) if values else {}
def translated(value):
    for item in value.translation:
        if item.language in ('en', ''): return item.text
    return ''

def parse_current(raw, now):
    feed = gtfs_realtime_pb2.FeedMessage(); feed.ParseFromString(raw)
    if not feed.header.HasField('timestamp') or feed.header.incrementality != 0:
        raise ValueError('Missing source timestamp or unsupported differential feed')
    alerts = []
    for entity in feed.entity:
        if not entity.HasField('alert') or entity.is_deleted: continue
        alert = entity.alert
        selectors = [s for s in alert.informed_entity if s.route_id == 'E' and s.agency_id in ('', 'MTASBWY')]
        if not selectors: continue
        periods = [{'start': int(p.start) if p.HasField('start') else None,
                    'end': int(p.end) if p.HasField('end') else None} for p in alert.active_period]
        active = not periods or any((p['start'] is None or p['start'] <= now.timestamp()) and
                                   (p['end'] is None or now.timestamp() < p['end']) for p in periods)
        if not active: continue
        ext = mercury(alert)
        alert_type = ext.get(3, [b'Unclassified alert'])[0].decode('utf-8')
        priorities = []
        for selector in selectors:
            order = mercury(selector).get(1, [b''])[0].decode('utf-8')
            try: priorities.append(int(order.rsplit(':', 1)[-1]))
            except ValueError: pass
        # Category comes from the official type; unknowns remain unclassified.
        planned = alert_type.lower().startswith('planned') or 'planned_work' in entity.id
        alerts.append({'id': entity.id, 'type': alert_type, 'planned': planned,
                       'priority': max(priorities, default=0), 'header': translated(alert.header_text),
                       'description': translated(alert.description_text), 'periods': periods,
                       'createdAt': ext.get(1, [None])[0], 'updatedAt': ext.get(2, [None])[0]})
    alerts.sort(key=lambda a: (-a['priority'], a['id']))
    return {'sourceAt': iso(datetime.fromtimestamp(feed.header.timestamp, timezone.utc)),
            'fetchedAt': iso(now), 'state': 'ok', 'alerts': alerts,
            'source': ALERTS, 'sha256': hashlib.sha256(raw).hexdigest()}

def history(rows, coverage_end, now, weeks=16):
    # event_id groups revisions. Date of first E+delay-label update defines the count week.
    events = {}
    planned = {}
    for row in sorted(rows, key=lambda r: (r['date'], int(r.get('update_number', 0)))):
        if row.get('agency') != 'NYCT Subway' or 'E' not in tokens(row.get('affected', '')): continue
        if not row.get('event_id'): raise ValueError('Archive row missing event_id')
        labels = tokens(row.get('status_label', ''))
        target = events if labels & DELAYS else planned if any(s.startswith('planned') for s in labels) else None
        if target is not None: target.setdefault(row['event_id'], row)
    end = local_date(coverage_end) if coverage_end else None
    start = monday(now.astimezone(NY)) - timedelta(weeks=weeks-1)
    weekly = []
    for index in range(weeks):
        day = start + timedelta(weeks=index)
        stop = datetime.combine(day + timedelta(days=7), datetime.min.time(), NY)
        status = 'unavailable' if end is None or day > end.date() else 'partial' if stop > end else 'archive-window'
        subset = [r for r in events.values() if monday(local_date(r['date'])) == day]
        work = [r for r in planned.values() if monday(local_date(r['date'])) == day]
        weekly.append({'start': str(day), 'coverage': status,
                       'count': len(subset) if status != 'unavailable' else None,
                       'days': len({local_date(r['date']).date() for r in subset}) if status != 'unavailable' else None,
                       'planned': len(work) if status != 'unavailable' else None})
    incidents = [{'eventId': key, 'firstDelayAt': row['date'], 'header': row['header'],
                  'labels': sorted(tokens(row['status_label'])), 'alertId': row['alert_id']} for key,row in events.items()]
    incidents.sort(key=lambda r:r['firstDelayAt'], reverse=True)
    # Calendar aggregates use the same full-history first-event dedup as weeks.
    today=now.astimezone(NY).date(); lower=min((local_date(r['date']).date() for r in rows),default=today)
    periods={}
    for kind,length in [('day',120),('month',12),('year',7)]:
        result=[]
        for index in range(length-1,-1,-1):
            if kind=='day':begin=today-timedelta(days=index);finish=begin+timedelta(days=1)
            elif kind=='month':
                number=today.year*12+today.month-1-index;begin=datetime(number//12,number%12+1,1).date();finish=datetime((number+1)//12,(number+1)%12+1,1).date()
            else:begin=datetime(today.year-index,1,1).date();finish=datetime(today.year-index+1,1,1).date()
            stop=datetime.combine(finish,datetime.min.time(),NY)
            status='unavailable' if end is None or begin>end.date() or finish<=lower else 'partial' if stop>end or begin<lower else 'archive-window'
            subset=[r for r in events.values() if begin<=local_date(r['date']).date()<finish]
            result.append({'start':str(begin),'end':str(finish),'coverage':status,'count':len(subset) if status!='unavailable' else None,'days':len({local_date(r['date']).date() for r in subset}) if status!='unavailable' else None})
        periods[kind]=result
    return {'coverageEnd': coverage_end, 'fetchedAt': iso(now), 'source': ARCHIVE,
            'periods':periods,'coverageStart':str(lower),'weeks': weekly, 'incidents': [i for i in incidents if i['firstDelayAt'][:10] >= str(start)], 'state': 'ok',
            'qualifyingRows': sum(1 for r in rows if r.get('agency') == 'NYCT Subway' and 'E' in tokens(r.get('affected','')) and tokens(r.get('status_label','')) & DELAYS),
            'distinctEvents': len(events), 'queryRows': len(rows)}

def performance(rows, now):
    months = {}
    for row in rows: months.setdefault(row['month'], []).append(row)
    output = []
    for month, group in sorted(months.items(), reverse=True):
        n = sum(float(r['num_passengers']) for r in group)
        if n <= 0: continue
        output.append({'month': month, 'passengers': n,
                       'journeyOnTime': 1-sum(float(r['over_five_mins']) for r in group)/n,
                       'extraWait': sum(float(r['total_apt']) for r in group)/n,
                       'extraRide': sum(float(r['total_att']) for r in group)/n})
    return {'months': output, 'state': 'ok', 'fetchedAt': iso(now), 'source': PERFORMANCE}

def victoria(now):
    source = 'https://api.tfl.gov.uk/Line/victoria/Status'
    rows = json.loads(fetch(source))
    if len(rows) != 1 or rows[0].get('id') != 'victoria': raise ValueError('Unexpected TfL line response')
    statuses = [{'label': r['statusSeverityDescription'], 'reason': r.get('reason','').strip(),
                 'validity': r.get('validityPeriods',[])} for r in rows[0]['lineStatuses']]
    # Line.modified and status.created are not reliable feed freshness timestamps.
    return {'state':'ok','fetchedAt':iso(now),'sourceAt':None,'source':source,'statuses':statuses,
            'definition':'Operator line status; not delayed trains or a punctuality percentage. Historical retention not verified.'}

def archive_rows():
    rows = []; offset = 0
    where = "agency='NYCT Subway' AND affected like '%E%'"
    while True:
        page = query(ARCHIVE, {'$where':where, '$order':'date ASC,alert_id ASC', '$limit':10000, '$offset':offset})
        rows.extend(r for r in page if 'E' in tokens(r.get('affected','')))
        if len(page) < 10000: break
        offset += len(page)
        if offset > 500000: raise ValueError('Archive pagination safety limit reached')
    return rows

def main():
    now = datetime.now(timezone.utc); target = ROOT/'rail-reliability/data/dashboard.json'
    previous = json.loads(target.read_text()) if target.exists() else {}
    output = {'schema': 1, 'generatedAt': iso(now), 'tozai': previous.get('tozai', {'state':'unavailable'})}
    jobs = {
        'current': lambda: parse_current(fetch(ALERTS), now),
        'victoria': lambda: victoria(now),
        'history': lambda: history(archive_rows(), query(ARCHIVE, {'$select':'max(date) as latest', '$where':"agency='NYCT Subway'"})[0].get('latest'), now),
        'performance': lambda: performance(query(PERFORMANCE, {'$where':"line='E'", '$order':'month DESC', '$limit':24}),now)
    }
    errors = []
    for name, job in jobs.items():
        try:
            cached = previous.get(name, {})
            if name in ('history', 'performance') and (name!='history' or len(cached.get('periods',{}).get('day',[]))>=120) and cached.get('state') == 'ok' and cached.get('fetchedAt') and (now - datetime.fromisoformat(cached['fetchedAt'].replace('Z','+00:00'))).total_seconds() < 86400:
                output[name] = cached
            else: output[name] = job()
        except Exception as error:
            # Preserve original source/fetch timestamps, never turn a failure into fresh data.
            output[name] = dict(previous.get(name, {}), state='error', attemptedAt=iso(now), error='Official source fetch or validation failed')
            errors.append(name); print(name+': '+str(error), file=sys.stderr)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2)+'\n')
    if errors: sys.exit(1)

if __name__ == '__main__': main()
