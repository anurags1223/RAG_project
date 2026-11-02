import os
import tempfile

# Every test run gets a separate store; user PDFs are never touched.
os.environ['PDF_CHAT_DATA'] = tempfile.mkdtemp(prefix='pdf-chat-tests-')
