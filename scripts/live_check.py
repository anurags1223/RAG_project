"""Optional real-model smoke test. Run with --model set to an installed Ollama model."""
import argparse
import io
import json
import time
from pathlib import Path

import httpx
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--base-url', default='http://127.0.0.1:8000')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
writer = PdfWriter()
page = writer.add_blank_page(width=612, height=792)
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
lines = [
    (24, 'A short guide to RAG'),
    (12, 'Retrieval-augmented generation'),
    (12, ''),
    (12, 'RAG helps a language model answer questions using your documents.'),
    (12, 'It has three main steps:'),
    (12, ''),
    (15, '1. Retrieve relevant passages'),
    (12, 'The system searches the document index for text related to your question.'),
    (12, 'Embeddings represent meaning as numerical vectors for similarity search.'),
    (12, ''),
    (15, '2. Build context'),
    (12, 'The retrieved passages are included alongside your question in the prompt.'),
    (12, 'Only a small number of useful passages need to be sent to the model.'),
    (12, ''),
    (15, '3. Generate a grounded answer'),
    (12, 'The local language model writes an answer using the supplied context.'),
    (12, 'Source references let you check the original document and page.'),
    (12, ''),
    (12, 'This application uses PyPDF, LangChain, ChromaDB, and a local model server.'),
    (12, 'Both Ollama and LM Studio can supply local models.'),
]
commands = ['BT /F1 12 Tf 50 735 Td']
for size, text in lines:
    safe = text.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
    commands.append(f'/F1 {size} Tf ({safe}) Tj 0 -25 Td')
commands.append('ET')
stream = DecodedStreamObject(); stream.set_data('\n'.join(commands).encode())
page[NameObject('/Contents')] = writer._add_object(stream)
output = io.BytesIO(); writer.write(output)
(root / 'examples').mkdir(exist_ok=True)
example = root / 'examples' / 'RAG Guide.pdf'; example.write_bytes(output.getvalue())

with httpx.Client(base_url=args.base_url, timeout=180, trust_env=False) as client:
    config = client.get('/api/settings').json()
    config.update(provider='ollama', chat_model=args.model, embedding_provider='ollama', embedding_model='nomic-embed-text', max_tokens=256)
    result = client.put('/api/settings', json=config); result.raise_for_status()
    result = client.post('/api/documents', files={'file':(example.name,output.getvalue(),'application/pdf')})
    if result.status_code not in (202,409): result.raise_for_status()
    deadline = time.monotonic() + 180
    while True:
        document = next(x for x in client.get('/api/documents').json() if x['name']==example.name)
        if document['status']=='ready': break
        if document['status']=='error': raise RuntimeError(document['error'])
        if time.monotonic()>deadline: raise TimeoutError('Indexing did not finish')
        time.sleep(.5)
    timings = []
    for label, question in [('cold','What are the three steps of RAG?'),('warm','List the three steps of RAG in one sentence.')]:
        started = time.perf_counter(); first = None; answer = ''; events = []
        with client.stream('POST','/api/chat',json={'question':question,'document_ids':[document['id']]}) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line: continue
                event = json.loads(line); events.append(event)
                if event['type']=='error': raise RuntimeError(event['message'])
                if event['type']=='token':
                    if first is None: first = time.perf_counter()-started
                    answer += event['text']
        assert events[-1]['type']=='done', events
        assert any(e['type']=='sources' for e in events)
        report = {'run':label,'first_token_seconds':round(first,2),'total_seconds':round(time.perf_counter()-started,2),'answer':answer,'conversation_id':events[0]['conversation_id']}
        timings.append(report); print(json.dumps(report),flush=True)
    (root/'data'/'live-check.json').write_text(json.dumps(timings,indent=2),encoding='utf-8')
