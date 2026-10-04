# Price-label font assets

Twelve families, each with unmodified static TrueType Regular (400) and Bold (700).
Local filenames are normalized to <font-id>/Regular.ttf and <font-id>/Bold.ttf; internal font names and bytes are unchanged.

The eleven new families were retrieved on 2026-10-04 from the official Google Fonts repository at commit 9710da1eacb3be272583c3224dcb70f9da6eadbb:
https://github.com/google/fonts/tree/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl
Each family includes the exact OFL.txt delivered with its source fonts (SIL Open Font License 1.1).

Roboto is copied byte-for-byte from the existing lib/pdf-fonts assets and Apache 2.0 LICENSE.txt.
Its original retrieval date is 2026-09-07; original URLs and historical hashes are documented in lib/pdf-fonts/SOURCE.md.
That historical source uses main rather than a pinned commit. The local copied bytes are fixed by the hashes in assets.json.

assets.json records all original font and licence URLs, source filenames, SHA-256 hashes, file sizes, weights, and provenance.
Fontkit 2.0.4 verified all 24 files as static TrueType fonts with actual OS/2 weights 400/700 and glyph coverage for Latin text, German umlauts, sharp s, and the euro sign.

| Font ID | Family | Licence |
| --- | --- | --- |
| roboto | Roboto | Apache-2.0 |
| lato | Lato | OFL-1.1 |
| pt-sans | PT Sans | OFL-1.1 |
| fira-sans | Fira Sans | OFL-1.1 |
| barlow | Barlow | OFL-1.1 |
| alegreya-sans | Alegreya Sans | OFL-1.1 |
| pt-serif | PT Serif | OFL-1.1 |
| ibm-plex-serif | IBM Plex Serif | OFL-1.1 |
| spectral | Spectral | OFL-1.1 |
| crimson-text | Crimson Text | OFL-1.1 |
| fira-mono | Fira Mono | OFL-1.1 |
| ibm-plex-mono | IBM Plex Mono | OFL-1.1 |
