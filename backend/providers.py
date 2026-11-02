"""Small streaming adapters for the two local inference servers."""
import json
from urllib.parse import urlparse

import httpx


def validate_url(value: str) -> str:
    url = urlparse(value)
    if url.scheme != 'http' or url.hostname not in {'localhost', '127.0.0.1', '::1'} or url.username or url.password or url.query or url.fragment:
        raise ValueError('Use a local HTTP server, for example http://localhost:1234/v1.')
    return value.rstrip('/')


class Provider:
    def __init__(self, kind: str, url: str):
        self.kind = kind
        self.url = validate_url(url)

    async def models(self):
        path = '/api/tags' if self.kind == 'ollama' else '/models'
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            response = await client.get(self.url + path)
            response.raise_for_status()
            data = response.json()
        return [x['name'] for x in data['models']] if self.kind == 'ollama' else [x['id'] for x in data['data']]

    def embed(self, texts: list[str], model: str) -> list[list[float]]:
        path = '/api/embed' if self.kind == 'ollama' else '/embeddings'
        body = {'model': model, 'input': texts}
        if self.kind == 'ollama':
            body['keep_alive'] = '30m'
        with httpx.Client(timeout=180, trust_env=False) as client:
            response = client.post(self.url + path, json=body)
            response.raise_for_status()
            data = response.json()
        if self.kind == 'ollama':
            return data['embeddings']
        return [x['embedding'] for x in sorted(data['data'], key=lambda x: x['index'])]

    async def stream(self, messages, model: str, max_tokens: int):
        body = {'model': model, 'messages': messages, 'stream': True}
        if self.kind == 'ollama':
            path = '/api/chat'
            body.update(keep_alive='30m', options={'num_predict': max_tokens, 'num_ctx': 4096, 'temperature': 0.2})
        else:
            path = '/chat/completions'
            body.update(max_tokens=max_tokens, temperature=0.2)
            # Qwen 3.5 can consume the entire short answer budget on hidden reasoning.
            # LM Studio accepts this switch to produce direct, faster PDF answers.
            if 'qwen3.5' in model.lower():
                body['reasoning_effort'] = 'none'
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=8), trust_env=False) as client:
            async with client.stream('POST', self.url + path, json=body) as response:
                if response.is_error:
                    await response.aread()
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    if self.kind == 'ollama':
                        data = json.loads(line)
                        if data.get('error'):
                            raise ValueError(data['error'])
                        token = data.get('message', {}).get('content', '')
                    else:
                        if not line.startswith('data:'):
                            continue
                        raw = line[5:].strip()
                        if raw == '[DONE]':
                            break
                        data = json.loads(raw)
                        if data.get('error'):
                            raise ValueError(str(data['error']))
                        token = (data.get('choices') or [{}])[0].get('delta', {}).get('content', '')
                    if token:
                        yield token
