# Embezzle Studio Context

Embezzle Studio is a local-first workspace for user-owned provider access, projects, conversations, knowledge, artifacts, and productivity tools.

## Language

**Workspace State**:
The user-owned local working set containing provider configuration references, projects, conversations, messages, artifacts, knowledge sources, productivity settings, and retained usage records.
_Avoid_: App state, global state

**Local Project**:
A user-defined grouping for conversations, instructions, artifacts, and knowledge sources that remains on the user's device.
_Avoid_: Remote workspace, cloud project

**Conversation Branch**:
A conversation created from a selected point in another conversation while retaining canonical lineage to the shared earlier messages.
_Avoid_: Duplicate conversation, copied chat
