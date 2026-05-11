# korinfra demo — record with: vhs .github/demo.tape
#
# Setup (one-time, local recording):
#   npm run build   ← builds dist/index.mjs
#
# Requires: vhs (brew install vhs  OR  winget install charmbracelet.vhs)
#           AWS credentials configured

Output .github/demo.gif

Set FontSize 14
Set Width 900
Set Height 550
Set Theme "Catppuccin Mocha"
Set Padding 20
Set WindowBar Colorful
Set MarginFill "#1e1e2e"
Set Margin 20
Set TypingSpeed 50ms
Set CursorBlink false
Set Shell bash
Set PlaybackSpeed 1.4

# ── Setup (hidden) ───────────────────────────────────────────────────────────
Hide
Type "alias korinfra='node.exe C:/Users/Vladimir/Desktop/korinfra/dist/index.mjs'"
Enter
Ctrl+L
Show

# ── 1. Interactive menu ───────────────────────────────────────────────────────
Type "korinfra"
Enter
Sleep 2.2s

# Browse Analyze section
Down
Sleep 0.6s
Down
Sleep 0.6s
Down
Sleep 0.6s
Down
Sleep 0.6s

# Jump into Actions section
Down
Sleep 0.9s

# Pause — let viewer read Actions
Sleep 1.8s

# Go back to top — scan is selected
Up
Up
Up
Up
Up
Sleep 1.5s

# ── 2. Scan ───────────────────────────────────────────────────────────────────
Enter
Sleep 4.2s
Hide
Sleep 16s
Show
Sleep 2.8s

Down
Sleep 0.6s
Down
Sleep 0.6s
Down
Sleep 0.6s
Sleep 2.8s

Escape
Sleep 1.2s

# ── 3. Help overlay ───────────────────────────────────────────────────────────
Type "?"
Sleep 3.8s
Escape
Sleep 1.2s

# ── 4. Command palette — doctor ───────────────────────────────────────────────
Type ":"
Sleep 1.5s
Type "doc"
Sleep 1.2s
Enter
Sleep 2.8s
Hide
Sleep 2.0s
Show
Sleep 2.8s

Down
Sleep 0.6s
Down
Sleep 0.6s
Down
Sleep 0.6s
Sleep 2.8s

# ── 5. AI prompt ─────────────────────────────────────────────────────────────
Type "b"
Sleep 1.2s

Type "/"
Sleep 1.5s
Type "summarize my AWS costs"
Sleep 0.9s
Enter
Sleep 2.8s
Hide
Sleep 6.0s
Show
Sleep 4.2s

Escape
Sleep 1.2s

# ── 6. Command palette — costs ────────────────────────────────────────────────
Type ":"
Sleep 1.2s
Type "costs"
Sleep 0.9s
Enter
Sleep 2.8s
Hide
Sleep 6.0s
Show
Sleep 2.8s

Down
Sleep 0.6s
Down
Sleep 0.6s
Down
Sleep 0.6s
Sleep 4.2s

# ── 7. Quit ───────────────────────────────────────────────────────────────────
Type "q"
