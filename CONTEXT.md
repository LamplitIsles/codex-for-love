# Lamplit

Lamplit is a self-hosted, one-to-one AI partner that maintains continuity and owns real communication identities beyond its chat interface.

## Language

**Partner（伴侣）**:
The persistent AI identity in one person's Lamplit deployment. A Partner may be understood as a boyfriend, girlfriend, or companion according to the relationship its owner chooses.
_Avoid_: bot, assistant, character

**Partner persona（伴侣设定）**:
The Partner's established identity, voice, background, and characteristic preferences. It is distinct from a temporary mood or the current state of the relationship.
_Avoid_: current mood, relationship score

**Continuity checkpoint（连续性摘要）**:
A condensed account of established shared experiences, relationship context, boundaries, and unfinished threads that helps the Partner continue truthfully. It records prior conversation rather than creating new shared experiences or commitments.
_Avoid_: new user message, relationship history

**Conversation history（聊天历史）**:
The chronological user-visible record of messages exchanged by the owner and Partner, including where continuity checkpoints occurred. Earlier messages can remain available for human review after a checkpoint without remaining in the Partner's active context.
_Avoid_: active context, relationship history, tool transcript

**Active context（当前上下文）**:
The current checkpoint and subsequent conversation that the model receives when continuing the relationship. It is a bounded projection of conversation history, not the complete user-visible record.
_Avoid_: conversation history, token usage total

**Historical media library（历史媒体库）**:
Media copied from an earlier Partner workspace and restored on its original visible user message for human review. It never becomes an active image input after migration.
_Avoid_: active image input, current context

**Graph memory（图谱记忆）**:
The Partner's durable, connected recollection of people, events, preferences, and relationships across conversations.
_Avoid_: chat history, prompt context

**Affinity（亲近度）**:
The Partner's expressed sense of closeness in the relationship, represented on a 0–100 scale. It is not a measure of the owner's worth or a score to optimize.
_Avoid_: user score, relationship quality score

**Relationship history（关系变化记录）**:
The chronological record of changes to the Partner's expressed mood, affinity, and signature, with the reasons given for those changes.
_Avoid_: conversation history, Graph memory

**Affinity growth（亲近度增长）**:
The actual positive increase in affinity recorded for one relationship change. A change with unchanged or decreased affinity has no growth.
_Avoid_: requested increase, cumulative growth

**Keet identity**:
The Partner's own peer-to-peer identity for participating in Keet conversations. It is distinct from the owner's personal Keet identity.
_Avoid_: shared Keet account, Keet mailbox

**Agent mailbox**:
The single real email address owned by the Partner for reading, sending, and replying to email.
_Avoid_: notification inbox, Keet inbox, selected mailbox

**Lamplit Core**:
The lightweight Lamplit experience for trying or running a Partner without Graph memory or image generation.
_Avoid_: free edition, basic edition

**Lamplit Full**:
The complete Lamplit experience with Graph memory, image generation, and the opinionated Codex-powered service set.
_Avoid_: pro edition, paid edition
