---
name: ohmygame-studio
description: Use OhMyGame's game studio tools from this agent - generate images, video, 3D models, animation, speech, sound effects and music with the person's configured providers, keep the project's Design and Asset Canvas valid, and playtest the game in a real window. Use when working in an OhMyGame project folder, or when the person asks for game art, 3D assets, audio, a playtest, or explicitly continuing an existing OhMyGame conversation.
---

# OhMyGame Studio

OhMyGame is a desktop app for making games. Its tools reach you through the
`ohmygame-studio` MCP server. You keep writing code with your own tools;
OhMyGame adds what you cannot do alone: media generation with the person's
providers, its canvas, and playing the game like a player.

## Choose the project

Media, canvas and playtest tools use the selected OhMyGame project.
Conversation tools instead require an explicit `project` on every call.

- Working inside a project's folder selects it. Call `get_project` to confirm
  the project, its type and its workspace folder.
- Otherwise call `list_projects`, then `open_project` with an ID or folder.
- If a tool says OhMyGame is turned off or could not be started, tell the
  person to open OhMyGame and turn on **Settings → MCP Server → Allow other
  agents to use OhMyGame**. Do not retry in a loop.

## Continue an existing OhMyGame conversation

Use this only when the person explicitly wants OhMyGame's agent to do the work;
it can incur model charges. Never automatically create a conversation or approve
anything for the person.

- Call `list_conversations` with an explicit `project` ID or absolute workspace
  path. Read the chosen conversation with `get_conversation`, always including
  `project` and `conversationId`. These calls are independent of `open_project`.
- Keep reusing **that same existing conversation** for continued work, rather
  than switching conversations between messages. If none exists, ask the person
  to create/select one in OhMyGame.
- `send_conversation_message` takes `project`, `conversationId`, a unique
  `requestId` and text `prompt`. It refuses busy/blocked/closing projects; it
  never queues. Different projects can run in parallel, one project is serial.
- Keep the returned stable `taskId` and call `wait_conversation_task` with
  `project`, `conversationId`, `taskId`. Each wait is at most 45 seconds;
  `timeoutSeconds: 0` queries immediately. Reconnect using the same task ID.
- `waiting_approval`, `waiting_input` and `waiting_plan` mean the person must
  act in OhMyGame. Report the blocker and stop; never automatically approve,
  answer, execute a plan, or try to bypass it by sending another message.
- `closing` and `cancelling` are not finished. Only `succeeded` confirms success;
  inspect the associated response. `cancel_conversation_task` requests abort of
  that exact task, not a different run in the conversation.
- After a lost send response, use `get_conversation` to find the request ID, or
  explicitly repeat the exact same request ID, conversation and text; this is
  idempotent even across connections. Never use a new request ID to retry.
  A daemon restart reports unfinished records as `interrupted`; an unrecognized
  ID is `unknown`. Neither means success or authorizes an automatic resend.

## Generate assets

Use `generate_image`, `generate_video`, `generate_3d_asset`,
`animate_3d_asset` and `generate_audio`. Each call uses the person's provider
credits, so:

- Write one specific prompt and generate once; do not try variations unless
  asked.
- Start 3D from an approved image: `generate_image` first, then
  `generate_3d_asset` with `imagePath`, then `animate_3d_asset` for rigged
  characters.
- Results name the saved file's workspace-relative path. Read the file with
  your own tools to check it before using it in the game.
- `generate_audio` makes speech, sound effects and music. Set `kind` and
  OhMyGame picks a model that makes it, or pick a `model` yourself. For a
  text-to-speech model the prompt is the exact line to speak; otherwise it
  describes the sound. Some models mix dialogue, ambience and music from one
  prompt. A model that sets `requiresVoice` needs a voice from its provider.
  Keep the returned audio JSON companion beside the audio in the project.

Generation can take minutes. A tool that is not done within about 45 seconds
returns a job ID: call `wait_job` with it until the job finishes. Never start
the same generation again while its job runs. `get_job` checks without
waiting; `cancel_job` stops a job the person no longer wants.

## Canvas

Projects keep design docs, concept art and assets on a canvas under
`canvas/`. If you change files there, run `canvas_check` and fix what it
reports. `canvas_initialize` creates the canvas in a project without one.
`generate_canvas_media` generates into an existing canvas node.

## Playtest

`game_use` opens the game in OhMyGame's player window, acts as a player and
captures screenshots. Use it after changing gameplay: a successful build is
not a playtest.

1. `open` returns a session ID and the first state.
2. `act` with a batch of input and wait steps; it returns the new state.
3. `capture` for screenshots of canvas or WebGL games.
4. `close` the session when finished.

A game a plugin runs outside OhMyGame, such as a TapTap Maker project, may
only offer `captureFrame`: it runs the game again from its start and captures
the frame you name. Pick a frame after the game has loaded, and a later one
when the capture is blank or still loading.

It needs the OhMyGame desktop app and a project with a game preview.

## Interactive Story projects

Use `playable_add_node` to add a screen and `playable_check` after changes;
use mode `publish` before the person publishes.

## What stays with you

Edit code and files, run commands, plan, and ask the person questions with
your own tools. OhMyGame cannot undo changes you make outside its tools, so
keep the project in version control.
