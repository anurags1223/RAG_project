import json

import pytest

from backend import main
from backend.providers import Provider
from backend.summaries import parse_summary, summary_sources
from test_app import app, sample_pdf


def result():
    return {'title': 'The library', 'overview': 'The ship has a library [1].',
            'visual_type': 'concepts', 'points': [
                {'title': 'Books', 'text': 'There are 42 books.', 'source': 1},
                {'title': 'Location', 'text': 'They are on the Going Merry.', 'source': 1}]}


def test_summary_round_trip_and_followup(app, monkeypatch):
    config = app.get('/api/settings').json()
    config['chat_model'] = 'test'
    app.put('/api/settings', json=config)
    doc_id = app.post('/api/documents', files={'file': ('summary.pdf', sample_pdf('Summary library: the Going Merry has 42 books.'))}).json()['id']
    async def stream(self, messages, model, max_tokens):
        assert '42 books' in messages[0]['content']
        assert max_tokens == 1200
        yield json.dumps(result())
    monkeypatch.setattr(Provider, 'stream', stream)
    events = [json.loads(line) for line in app.post('/api/chat', json={
        'question': 'Summarize', 'mode': 'summary', 'document_ids': [doc_id]}).text.splitlines()]
    assert events[-1]['type'] == 'done', events
    summary = next(e['summary'] for e in events if e['type'] == 'summary')
    assert not summary['coverage']['sampled']
    history = app.get('/api/conversations/' + events[0]['conversation_id']).json()
    assert history[-1]['summary'] == summary
    assert '**Books**' in history[-1]['content']
    # Invalid structured output produces a useful error, never raw JSON history.
    async def invalid(*args):
        yield '{"broken":'
    monkeypatch.setattr(Provider, 'stream', invalid)
    response = app.post('/api/chat', json={'question': 'Summarize', 'mode': 'summary', 'document_ids': [doc_id]})
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]['type'] == 'error'
    assert not main.generation_lock.locked()
    assert len(app.get('/api/conversations/' + events[0]['conversation_id']).json()) == 1


def test_rejects_invented_references():
    value = result()
    value['points'][0]['source'] = 99
    with pytest.raises(ValueError, match='could not format'):
        parse_summary(json.dumps(value), [{'number': 1}], {})


def test_sampling_spans_documents_with_bounded_context():
    class Collection:
        def get(self, where, include):
            doc = where['document_id']
            return {'ids': [f'{doc}:{i}' for i in range(40)],
                    'documents': ['a' * 790] * 40,
                    'metadatas': [{'document_id': doc, 'page': i + 1} for i in range(40)]}
    sources, coverage = summary_sources(Collection(), ['a', 'b'])
    assert sum(len(s['text']) for s in sources) <= 7000
    assert {s['document_id'] for s in sources} == {'a', 'b'}
    assert {1, 40}.issubset({s['page'] for s in sources})
    assert coverage['sampled'] and coverage['total'] == 80
