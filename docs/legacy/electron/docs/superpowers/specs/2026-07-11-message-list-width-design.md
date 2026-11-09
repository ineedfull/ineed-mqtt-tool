# Message List Width Design

## Goal

Use substantially more of the message pane so long topics and payloads remain readable, while preserving the visual distinction between received and sent messages.

## Layout

- Each message row may use up to 92% of the message pane width.
- Received rows remain aligned to the left, leaving about 8% space on the right.
- Sent rows remain aligned to the right, leaving about 8% space on the left.
- The message bubble fills the full width of its row.
- Received headers align left and sent headers align right.
- Existing incoming/outgoing colors, subscription colors, copy controls, retained badges, and large-font behavior remain unchanged.

## Responsive Behavior

The 92% width is relative to the available message pane, so it applies consistently on desktop and narrow windows without viewport-based font scaling.

## Verification

- Add a CSS contract test for 92% row width and full-width bubbles.
- Verify both Electron and Tauri tests and production builds.
- Visually check received and sent messages in a running desktop client.
