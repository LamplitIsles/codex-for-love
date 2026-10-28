import { z } from 'zod';
export const Id = z.string().min(1).max(256);
export const Content = z.discriminatedUnion('type', [
  z.object({type:z.literal('text'),text:z.string().max(16384)}).strict(),
  z.object({type:z.literal('mention'),native_user_id:Id}).strict(),
  ...(['image','file','audio','video'] as const).map(type=>z.object({type:z.literal(type),asset_id:Id}).strict()),
]);
// Names select recipients only at send admission; archived content stays native-ID based.
export const SendContent = z.union([Content,z.object({type:z.literal('mention'),name:Id.describe('Exact member name. QQ: observed speakers in this chat only, not a current roster. Matrix: joined members. Use native_user_id when unavailable or ambiguous.')}).strict()]);
export const Asset = z.object({asset_id:Id,status:z.enum(['available','unavailable']),mime:z.string(),name:z.string(),size:z.number().int().nonnegative().nullable(),download_path:z.string().nullable(),reason:z.string().optional()}).strict();
export const Message = z.object({id:Id,account_id:Id,platform:z.enum(['qq','matrix']),conversation:z.object({id:Id,native_id:Id,type:z.enum(['direct','group']),name:z.string().min(1).max(256).optional()}).strict(),sender:z.object({native_id:Id,name:z.string().optional()}).strict(),timestamp:z.number().int(),sequence:z.number().int().positive(),native_message_id:Id,content:z.array(Content).max(64),assets:z.array(Asset).max(64),mentions:z.object({self:z.boolean(),native_user_ids:z.array(Id)}).strict(),reply:z.object({message_id:Id.nullable(),native_message_id:Id,author_native_id:Id.nullable(),verified:z.boolean()}).strict().nullable(),direction:z.enum(['inbound','outbound']),mutation:z.enum(['edit','retraction']).nullable()}).strict();
export const PostEventV1 = z.object({schema_version:z.literal(1),type:z.literal('message'),delivery_id:Id,agent_id:Id,message:Message,wake:z.object({reason:z.enum(['direct_message','mentioned','replied_to_self','alias_matched'])}).strict()}).strict();
const page={limit:z.number().int().min(1).max(100).optional(),before:Id.optional()};
const target={conversation_name:Id,account_id:Id.optional(),platform:z.enum(['qq','matrix']).optional(),conversation_type:z.enum(['group','direct']).optional()};
export const ToolInputs = {
 list_accounts:z.object({}).strict(),
 list_conversations:z.object({account_id:Id,...page}).strict(),
 get_conversation:z.object(target).strict(),
 list_members:z.object({...target,...page}).strict(),
 read_messages:z.object({...target,...page}).strict(),
 get_asset:z.object({asset_id:Id}).strict(),
 // Keep the named caller key order: its serialized bytes fingerprint accepted requests.
 send_message:z.object({
  account_id:Id.optional(),request_id:Id,
  content:z.array(SendContent).min(1).max(64),reply_to_message_id:Id.optional(),
  conversation_name:Id.describe('Exact current conversation name. Names do not grant access.').min(1),
  platform:z.enum(['qq','matrix']).optional(),conversation_type:z.enum(['group','direct']).optional(),
 }).strict(),
};
export type MessageV1=z.infer<typeof Message>;
export type AssetV1=z.infer<typeof Asset>;
export type EventV1=z.infer<typeof PostEventV1>;
export type ContentV1=z.infer<typeof Content>;
export const Capability=z.enum(['supported','unsupported','permission_required','unavailable']);
export const Capabilities=z.object({members:Capability,history:z.literal('observed'),text:Capability,image:Capability,file:Capability,audio:z.literal('attachment'),video:z.literal('attachment')}).strict();
export const Account=z.object({account_id:Id,platform:z.enum(['qq','matrix']),native_id:Id,ready:z.boolean(),capabilities:Capabilities}).strict();
export const Conversation=z.object({account_id:Id,conversation_id:Id,native_id:Id,type:z.enum(['direct','group']),name:Id,capabilities:Capabilities}).strict();
export const Member=z.object({native_id:Id,name:z.string().optional()}).strict();
export const Receipt=z.object({index:z.number().int().nonnegative(),status:z.enum(['sent','failed','unknown']),native_message_ids:z.array(Id),stored:z.boolean(),error:z.string().optional()}).strict();
export const SendResult=z.object({request_id:Id,status:z.enum(['sent','failed','unknown','partial']),parts:z.array(Receipt),stored:z.boolean()}).strict();
const paged=<T extends z.ZodType>(item:T)=>z.object({items:z.array(item),next_before:Id.nullable()}).strict();
export const ToolOutputs={list_accounts:z.object({items:z.array(Account)}).strict(),list_conversations:paged(Conversation),get_conversation:Conversation,list_members:z.object({items:z.array(Member),next_before:Id.nullable(),capability:Capability}).strict(),read_messages:paged(Message),get_asset:Asset,send_message:SendResult};
export const ToolError=z.object({error:z.object({code:z.enum(['unauthorized','not_found','invalid_request','conflict','unavailable','capacity','internal']),message:z.string()}).strict()}).strict();
