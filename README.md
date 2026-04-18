# Web Library Assistant — Chrome Extension

A library-first Chrome side panel extension for collecting website knowledge with translation, notes, markers, and AI chat.

## Features

- **Auto-translate on selection** — Select text on any webpage and it appears in the sidebar instantly
- **13+ languages** — Japanese, English, German, French, Spanish, Chinese, Korean, and more
- **Language swap** — Swap source/target languages with one click
- **Copy to clipboard** — Copy translation results instantly
- **Keyboard shortcut** — `Ctrl+Enter` to translate
- **AI Chat** — Chat-style panel that uses full page content and prioritizes selected text as context
- **AI provider settings** — Register API key per provider and switch models dynamically
- **Auto model discovery** — Models are fetched automatically from the selected provider
- **Library** — Organize saved sites and notes with folder tree, move sites, and search by title/URL/note text
- **Notes** — Per-page Markdown notes with KaTeX math rendering and multi-table support
- **Markers** — Highlight and save text selections on any page with color labels
- **Noise-reduced context** — Filters navigation/ads/footer-like content before sending page context to AI
- **Dark theme UI** — Minimal black-based design for a distraction-free experience
- **Free & Pro API support** — Works with DeepL's free and paid API plans

## Installation

### 1. Get a DeepL API Key

Sign up for a free account at [deepl.com/pro](https://www.deepl.com/pro#developer) and copy your API key.

### 2. Load the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **"Load unpacked"**
4. Select this folder (`web-library`)

### 3. Configure API Key

1. Click the extension icon in the toolbar — the sidebar opens
2. Click the settings icon
3. Enter your DeepL API key and select your plan (Free / Pro)
4. Click **Save**

### 4. Configure AI Provider

1. Open **Settings**
2. Select AI Provider (OpenAI / Anthropic / Gemini)
3. Enter API key for the selected provider
4. Model list is auto-fetched from provider (fallback list is used if fetch fails)
5. Choose model
6. Click **Save**

## Usage

1. Open the sidebar by clicking the extension icon
2. Browse any webpage and **select text** — it appears automatically in the Original field
3. Translation runs instantly (when Auto-translate is on)
4. Or type/paste text manually and press **Translate**
5. Use the **Notes** tab to write Markdown notes (with math support) for the current page
6. Use the **Markers** tab to save highlighted text selections with color labels
7. Use the **Library** tab to browse and search all saved sites, notes, and folders
8. Use the **AI** tab to chat about the current page content

## File Structure

```text
web-library/
├── manifest.json              # Manifest V3 configuration
├── core/
│   ├── background.js          # Service Worker — API calls & message routing
│   └── db/
│       └── repository.js      # IndexedDB layer (Dexie.js)
├── features/
│   ├── ai/
│   │   └── sidepanel/
│   │       └── ai-chat.js     # AI chat UI logic
│   ├── library/
│   │   └── sidepanel/
│   │       └── library-panel.js  # Library UI logic (folders/sites/notes)
│   ├── marker/
│   │   └── sidepanel/
│   │       └── marker-panel.js   # Marker UI logic (highlight/save selections)
│   ├── notes/
│   │   └── sidepanel/
│   │       └── note-panel.js     # Notes UI logic (Markdown + KaTeX)
│   └── translate/
│       ├── content.js         # Content script — text selection detection
│       └── sidepanel/
│           ├── sidepanel.html # Side panel UI
│           ├── sidepanel.css  # Dark theme styles
│           └── sidepanel.js   # Side panel logic
├── vendor/
│   ├── dexie.min.js           # IndexedDB wrapper
│   ├── katex.min.js           # Math rendering
│   ├── katex.min.css
│   ├── markdown-it.min.js     # Markdown rendering
│   ├── markdown-it-multimd-table.min.js
│   └── fonts/                 # KaTeX fonts
└── icons/                     # Extension icons (16/48/128px)
```

## Tech Stack

- **Manifest V3** Chrome Extension
- **Chrome Side Panel API** (`chrome.sidePanel`)
- **DeepL API** (Free: `api-free.deepl.com`, Pro: `api.deepl.com`)
- **Dexie.js** — IndexedDB wrapper for local persistence
- **markdown-it** — Markdown rendering in notes (with multimd-table plugin)
- **KaTeX** — Math expression rendering in notes
- Vanilla HTML / CSS / JavaScript — zero build step

## Privacy

- Your API keys are stored locally in `chrome.storage.local` (never sent anywhere except the respective provider)
- Text is sent to DeepL's servers only for translation
- AI chat context is sent only to the configured AI provider
- No analytics or tracking

## License

MIT
