# Lamplit

Lamplit is a self-hosted, one-to-one AI partner that maintains continuity and owns real communication identities beyond its chat interface.

## Language

**Companion connection（聊天界面连接）**:
The Human's live access to the Partner's current conversation state. Losing this connection does not mean the Partner's active work has stopped.
_Avoid_: Partner execution state, task cancellation

**Companion notification（聊天提醒）**:
A privacy-preserving notice that identifies the Partner and that something new arrived after a Partner turn completes successfully, without revealing message content.
_Avoid_: message preview, Partner turn status

**Chat background（聊天背景）**:
An optional decorative image behind the Human and Partner's conversation in Companion. It is separate from message content and does not belong to the Chat Image Library.
_Avoid_: chat image, shared conversation media

**Partner alarm（伴侣闹钟）**:
A Partner-authored schedule for delivering a stored message to the Partner's single conversation at a chosen time. It may be one-time or recurring, and does not designate an external recipient.
_Avoid_: Companion notification, separate conversation, Human reminder

**Alarm occurrence（闹钟触发）**:
One due delivery from a Partner alarm that starts an Agent turn. It appears in conversation history as the Partner's own reminder, distinct from a Human or Keet message; a recurring alarm can have many occurrences.
_Avoid_: alarm definition, Human message, automatic Keet reply

**Human（人类参与者）**:
The person in the one-to-one conversation. Human identifies the conversation role and media source; it does not mean a resource owner or operator.
_Avoid_: owner when referring to a conversation participant

**Agent（智能体）**:
The AI actor that responds and generates media in the conversation. The Partner is the Agent's persistent product identity, not a second participant-role term.
_Avoid_: Partner-generated when identifying a media source

**Partner（伴侣）**:
The persistent AI identity in one person's Lamplit deployment. A Partner may be understood as a boyfriend, girlfriend, or companion according to the relationship its Human chooses.
_Avoid_: bot, assistant, character

**Partner persona（伴侣设定）**:
The Partner's established identity, voice, background, and characteristic preferences. It is distinct from a temporary mood or the current state of the relationship.
_Avoid_: current mood, relationship score

**Continuity checkpoint（连续性摘要）**:
A condensed account of established shared experiences, relationship context, boundaries, and unfinished threads that helps the Partner continue truthfully. It records prior conversation rather than creating new shared experiences or commitments.
_Avoid_: new user message, relationship history

**Conversation history（聊天历史）**:
The chronological user-visible record of messages exchanged by the Human and Partner, including where continuity checkpoints occurred. Earlier messages can remain available for human review after a checkpoint without remaining in the Partner's active context.
_Avoid_: active context, relationship history, tool transcript

**Conversation search（聊天记录搜索）**:
A way to find text in the locally indexed conversation record set available to this Partner. A result is an excerpt that opens its source message and nearby context; searching does not change the active conversation.
_Avoid_: relationship history search, active-context lookup

**Active context（当前上下文）**:
The current checkpoint and subsequent conversation that the model receives when continuing the relationship. It is a bounded projection of conversation history, not the complete user-visible record.
_Avoid_: conversation history, token usage total

**Post-compaction tail（压缩后尾部）**:
The configured number of most recent complete Human/Partner text rounds supplied by CFL only at a native compaction boundary. It preserves immediate conversational continuity alongside the native continuity checkpoint; it contains neither tool content nor the complete conversation history.
_Avoid_: continuity checkpoint, complete text round, conversation history

**Historical media library（历史媒体库）**:
Media copied from an earlier Partner workspace and restored on its original visible user message for human review. It never enters active image input automatically after migration; explicit native inspection is separate.
_Avoid_: automatic active image input, current context

**Historical media time（历史媒体时间）**:
The time used to place restored Historical media in the Chat Image Library: the original message time when retained conversation evidence verifies it, otherwise a declared synthetic fallback that preserves imported order without claiming a send time.
_Avoid_: service-start time, filesystem modification time

**Chat Image Library（聊天图片库）**:
The shared, finite conversation-owned catalogue of Human-sent, Agent-generated, and restored Historical media images. Humans browse it in the drawer and Partners discover the same membership through bounded Companion MCP pages. Explicit native inspection never adds an item, and Historical media remains out of active context unless deliberately inspected.

**Graph memory（图谱记忆）**:
The Partner's durable, connected recollection of people, events, preferences, and relationships across conversations.
_Avoid_: chat history, prompt context

**Affinity（亲近度）**:
The Partner's expressed sense of closeness in the relationship, represented on a 0–100 scale. It is not a measure of the Human's worth or a score to optimize.
_Avoid_: user score, relationship quality score

**Relationship history（关系变化记录）**:
The chronological record of changes to the Partner's expressed mood, affinity, and signature, with the reasons given for those changes.
_Avoid_: conversation history, Graph memory

**Relationship Journal（关系日志）**:
The append-only workspace record that is the source of truth for the Partner's current relationship state and relationship history.
_Avoid_: conversation history, relationship projection, session metadata

**Relationship Projection（关系投影）**:
The current relationship state and history derived from the Relationship Journal for display or context bootstrap.
_Avoid_: Relationship Journal, independent relationship state

**Companion MCP**:
The workspace-scoped tool service through which the Partner reads and changes relationship state and uses other Lamplit-specific capabilities.
_Avoid_: Codex built-in tools, session tool snapshot

**Voice message（语音消息）**:
A standalone incoming playable audio message deliberately sent by the Partner. It does not imply a transcript or an accompanying text message.
_Avoid_: recorded Human input, text-to-speech tag

**Voice dispatch（语音派发）**:
The Companion MCP action that synthesizes and delivers a Voice message as evidence in the same official Codex turn.
_Avoid_: automatic reply reading, a second conversation executor

**Minimal MCP configuration（极简 MCP 配置）**:
A Partner workspace configuration containing only CFL's bundled Companion MCP among CFL-provided integrations. It lets the Partner start without Lamplit ecosystem services.
_Avoid_: no-tools mode, MCP-free configuration

**Ecosystem MCP template（生态 MCP 模板）**:
A static, operator-copyable Codex TOML example that adds the selected Lamplit ecosystem MCPs to the minimal configuration. It is optional and does not make those services a Partner startup prerequisite.
_Avoid_: deployment profile, auto-provisioned integration

**Affinity growth（亲近度增长）**:
The actual positive increase in affinity recorded for one relationship change. A change with unchanged or decreased affinity has no growth.
_Avoid_: requested increase, cumulative growth

**Keet identity**:
The Partner's own peer-to-peer identity for participating in Keet conversations. It is distinct from the Human's personal Keet identity.
_Avoid_: shared Keet account, Keet mailbox

**Keet ingress（Keet 入站）**:
The optional local webhook delivery of external Keet messages to a Partner. Ordinary Group messages are retained as bounded context; a qualifying Group message or DM starts a turn, while Broadcast messages do not. When it is not configured or unavailable, the Partner's ordinary local conversation remains available and receives no Keet-derived input.
_Avoid_: required Partner dependency, Keet read state, automatic reply

**Keet-sourced message（Keet 来源消息）**:
An admitted Keet message in the Partner's single conversation: a DM is ordinary one-to-one speech, while a Group sender label does not establish identity because people can join through invite links. Neither source inherits the Human's administrative authority.
_Avoid_: Human message, anonymous user bubble, separate Keet session

**Trusted Keet Group（可信 Keet 群组）**:
An admitted Keet Group explicitly designated by the Owner whose members' messages the Partner treats as ordinary conversation, including from members who join later. This conversational trust does not verify a sender's identity or grant the Human's administrative authority.
_Avoid_: verified sender, Human-owned channel, privileged instructions

**Inbound Keet Image（入站 Keet 图片）**:
An image accompanying an admitted external Keet message, including an image-only message. The Keet gateway owns the retained original and its reference. For a triggered DM, the Partner fetches usable images into its own attachments for native Agent input; unavailable images remain visible as a fact. Group images remain bounded context, and Broadcast images do not start a turn.
_Avoid_: webhook image bytes, local shared media path

**Keet Trigger（Keet 触发）**:
An external Keet message classified by its receiving Partner as one that may start a turn. The gateway supplies addressing facts; the receiver owns this decision. A Group Trigger is a verified native mention, a current identity-label or configured trigger-alias match, or a reply to an identity-authored Keet message; every external DM message is a separate trigger. Broadcasts have no Keet Trigger.
_Avoid_: every Group message, outgoing Keet message, automatic reply

**Keet trigger alias（Keet 触发别名）**:
An optional name that the Owner configures for the Partner in addition to its current Keet identity label. Its appearance in an admitted Group message may start a Partner turn without changing that Group's conversational trust.
_Avoid_: trusted Group name, sender identity, Keet profile name

**Keet Group Context Buffer（Keet 群组上下文缓冲）**:
The bounded per-Group sequence of ordinary external Group messages retained until the next Keet Trigger for that same Group. It accompanies that trigger as context, without appearing as separate messages in the Human's chat timeline or starting independent Partner turns.
_Avoid_: global group history, a Broadcast buffer, standalone turn queue

**Keet Reaction Context（Keet 表情回应上下文）**:
The aggregate state of others' emoji reactions to the Partner's Keet messages, supplied with admitted Group or DM messages independently of turn classification and used by the receiving Partner on a qualifying turn. It is untrusted context, has no reactor identity, and does not independently start a Partner turn.
_Avoid_: reaction-triggered turn, attributed reaction, standalone message

**Keet Reaction Response（Keet 表情回应）**:
An explicit Partner text send paired with an optional emoji reaction to one identified message in the same Group or DM. For a DM turn, that target is its own triggering message; the reaction never replaces the text.
_Avoid_: automatic reply, standalone reaction, latest-arrived DM target

**Agent mailbox**:
The single real email address owned by the Partner for reading, sending, and replying to email.
_Avoid_: notification inbox, Keet inbox, selected mailbox

**Lamplit Core**:
The lightweight Lamplit experience for trying or running a Partner without Graph memory or image generation.
_Avoid_: free edition, basic edition

**Lamplit Full**:
The complete Lamplit experience with Graph memory, image generation, and the opinionated Codex-powered service set.
_Avoid_: pro edition, paid edition
