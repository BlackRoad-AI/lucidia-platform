'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

// Only @blackboxprogramming and @lucidia route to local Ollama — no external vendors.
const OLLAMA_TRIGGER_PATTERN = /^@(blackboxprogramming|lucidia)\b/i;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        routing: 'ollama-local',
        ollama: OLLAMA_BASE_URL,
        model: OLLAMA_MODEL,
    });
});

// ── Chat — always routes to local Ollama, never to external vendors ──────────
app.post('/api/chat', async (req, res) => {
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
    }

    // Determine system persona based on @mention
    let systemPrompt = 'You are Lucidia, a sovereign AI companion built by BlackRoad AI.';
    if (OLLAMA_TRIGGER_PATTERN.test(message.trim())) {
        const mention = message.trim().match(OLLAMA_TRIGGER_PATTERN)[1].toLowerCase();
        if (mention === 'blackboxprogramming') {
            systemPrompt = 'You are @blackboxprogramming, a sovereign AI coding assistant built by BlackRoad AI running on local infrastructure.';
        } else {
            systemPrompt = 'You are @lucidia, a sovereign AI companion built by BlackRoad AI running on local infrastructure.';
        }
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
    ];

    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
            signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.error(`[ollama] HTTP ${response.status}:`, text);
            return res.status(502).json({ error: `Ollama returned HTTP ${response.status}` });
        }

        const data = await response.json();
        const reply = data.message?.content ?? data.response ?? '';
        return res.json({ reply, model: OLLAMA_MODEL, routing: 'local' });
    } catch (err) {
        console.error('[ollama] error:', err.message);
        return res.status(502).json({
            error: 'Local AI unavailable. Make sure Ollama is running on ' + OLLAMA_BASE_URL,
        });
    }
});

app.listen(PORT, () => {
    console.log(`🖤  Lucidia server  →  http://localhost:${PORT}`);
    console.log(`🤖  AI routing      →  Ollama at ${OLLAMA_BASE_URL}  (model: ${OLLAMA_MODEL})`);
    console.log(`🚫  External vendors (OpenAI / Anthropic / Codex) are disabled.`);
});
