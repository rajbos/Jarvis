import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import './chat.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

declare const window: Window & {
  jarvis: {
    getSelectedOllamaModel(): Promise<string | null>;
    sendChatMessage(messages: Array<{ role: string; content: string }>): Promise<{ ok: boolean }>;
    abortChat(): Promise<void>;
    onChatToken(callback: (token: string) => void): void;
    onChatDone(callback: () => void): void;
    onChatError(callback: (error: string) => void): void;
    getChatAlwaysOnTop(): Promise<boolean>;
    setChatAlwaysOnTop(value: boolean): Promise<{ ok: boolean }>;
  };
};

// ── Markdown renderer ─────────────────────────────────────────────────────────
// Lightweight renderer — no external dependency.
function renderMarkdown(raw: string): string {
  // 1. Escape HTML entities
  let html = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Fenced code blocks (handles unclosed blocks at end of partial stream)
  html = html.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, _lang, code: string) =>
    `<pre class="code-block"><code>${code.trim()}</code></pre>`
  );

  // 3. Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

  // 4. Bold
  html = html.replace(/\*\*([^*\n]+?)(?:\*\*|$)/g, '<strong>$1</strong>');

  // 5. Headings (### ## #)
  html = html.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // 6. Double newlines → paragraph break; single newlines → <br>
  html = html.replace(/\n\n+/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  return (
    <div class={`message ${msg.role}`}>
      <div
        class="message-content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
      />
    </div>
  );
}

// ── Streaming bubble ──────────────────────────────────────────────────────────

function StreamingBubble({ text }: { text: string }) {
  return (
    <div class="message assistant">
      <div
        class="message-content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) || '&nbsp;' }}
      />
      <span class="typing-cursor" aria-hidden="true">{'▋'}</span>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Init: load model + register IPC event listeners (once) ──────────────
  useEffect(() => {
    window.jarvis.getSelectedOllamaModel()
      .then(setModel)
      .catch((err: unknown) => console.error('[Chat] getSelectedOllamaModel:', err));

    window.jarvis.getChatAlwaysOnTop()
      .then(setPinned)
      .catch((err: unknown) => console.error('[Chat] getChatAlwaysOnTop:', err));

    window.jarvis.onChatToken((token) => {
      streamRef.current += token;
      setStreamText(streamRef.current);
    });

    window.jarvis.onChatDone(() => {
      const finalText = streamRef.current;
      streamRef.current = '';
      setStreamText('');
      setStreaming(false);
      if (finalText) {
        setMessages((prev) => [...prev, { role: 'assistant', content: finalText }]);
      }
    });

    window.jarvis.onChatError((err) => {
      streamRef.current = '';
      setStreamText('');
      setStreaming(false);
      setError(err);
    });
  }, []);

  // ── Auto-scroll to bottom on new content ─────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText]);

  // ── Auto-resize textarea ──────────────────────────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [input]);

  // ── Send handler ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !model) return;

    setError(null);
    const newMessages: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    streamRef.current = '';
    setStreamText('');

    try {
      await window.jarvis.sendChatMessage(newMessages);
    } catch (err: unknown) {
      setStreaming(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [input, messages, streaming, model]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleTogglePin = useCallback(async () => {
    const next = !pinned;
    await window.jarvis.setChatAlwaysOnTop(next);
    setPinned(next);
  }, [pinned]);

  const noModel = !model;
  const inputDisabled = noModel || streaming;
  const sendDisabled = inputDisabled || !input.trim();

  return (
    <div class="chat-container">
      {/* Header */}
      <div class="chat-header">
        <span class="chat-title">Jarvis Chat</span>
        {model
          ? <span class="chat-model-badge" title={model}>{model}</span>
          : <span class="chat-model-badge none">No model selected</span>
        }
        <button
          class={`chat-pin-btn${pinned ? ' pinned' : ''}`}
          title={pinned ? 'Unpin \u2014 allow other windows to cover this' : 'Pin \u2014 keep on top of other windows'}
          onClick={() => void handleTogglePin()}
        >
          {'\uD83D\uDCCC'}
        </button>
      </div>

      {/* Messages */}
      <div class="chat-messages" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div class="chat-empty">
            <div class="chat-empty-icon">{'💬'}</div>
            <p>Ask me about your repositories, organizations, recent activity, or anything in your indexed GitHub data.</p>
            {noModel && (
              <p style={{ marginTop: '0.5rem', color: '#e94560' }}>
                Select an Ollama model in the main window first.
              </p>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}

        {streaming && <StreamingBubble text={streamText} />}

        {error && (
          <div class="chat-error">{error}</div>
        )}
      </div>

      {/* Input */}
      <div class="chat-input-area">
        <textarea
          ref={textareaRef}
          class="chat-input"
          placeholder={
            noModel
              ? 'Select a model in the main window first…'
              : 'Ask about your repos, orgs, or codebase… (Enter to send, Shift+Enter for newline)'
          }
          disabled={inputDisabled}
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          class="chat-send"
          disabled={sendDisabled}
          onClick={() => void handleSend()}
          title="Send (Enter)"
        >
          {streaming ? '…' : 'Send'}
        </button>
      </div>
      <div class="chat-input-hint">Enter to send · Shift+Enter for new line</div>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

const root = document.getElementById('app')!;
render(<App />, root);
