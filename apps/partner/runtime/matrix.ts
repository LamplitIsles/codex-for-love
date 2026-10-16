/** Historical persisted provenance only. New QQ/Matrix ingress belongs to Post. */
export type MatrixEvent = {
  type: 'message'; event_id: string; room_id: string; sender_id: string;
  sender_display_name: string; timestamp: number; body: string; mentions: string[];
  reply_to_event_id?: string; conversation_type?: 'dm' | 'room';
  reply_to_sender_id?: string; truncated: boolean;
};
export type MatrixContext = { provenance: MatrixEvent; trigger: 'dm' | 'mention' | 'reply' | 'alias'; roomContext?: string };
