import type { ServerNotificationEnvelope as ServerNotification } from "./generated/protocol/ServerNotificationEnvelope";
export type {
  ServerRequestFor,
  ServerRequestMethod,
  ServerRequestResponseMap,
  TypedServerRequestHandler,
} from "./generated/server-request-methods";

export type ServerNotificationMethod = ServerNotification["method"];
export type ServerNotificationFor<M extends ServerNotificationMethod> = Extract<
  ServerNotification,
  { method: M }
>;
export type TypedNotificationHandler<M extends ServerNotificationMethod> = (
  params: ServerNotificationFor<M>["params"],
  notification: ServerNotificationFor<M>,
) => void | Promise<void>;
