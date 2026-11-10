import type { FunctionCallOutputContentItem } from "./generated/protocol/FunctionCallOutputContentItem";
import type { TurnToolOutput } from "./generated/protocol/v2/TurnToolOutput";

export interface ExternalMessageOptions {
  toolName: string;
  content: string | readonly FunctionCallOutputContentItem[];
  namespace?: string | null;
}

/** Untrusted tool-level content. This never supplies user permission or approval. */
export class ExternalMessage {
  readonly toolName: string;
  readonly content: string | readonly FunctionCallOutputContentItem[];
  readonly namespace: string | null;

  constructor({ toolName, content, namespace = null }: ExternalMessageOptions) {
    this.toolName = toolName;
    this.content = content;
    this.namespace = namespace;
    this.toToolOutput();
  }

  toToolOutput(): TurnToolOutput {
    if (typeof this.toolName !== "string" || !this.toolName.trim()) {
      throw new TypeError("ExternalMessage.toolName must be a nonempty string.");
    }
    if (this.namespace !== null && typeof this.namespace !== "string") {
      throw new TypeError("ExternalMessage.namespace must be a string or null.");
    }
    if (typeof this.content !== "string" && !Array.isArray(this.content)) {
      throw new TypeError("ExternalMessage.content must be text or function-output content items.");
    }
    // The pinned protocol validator validates every structured item before sending the RPC.
    return { name: this.toolName, namespace: this.namespace,
      output: typeof this.content === "string" ? this.content : [...this.content] };
  }
}

/** Reject unknown/older runtimes rather than risk their ignoring the tool-authority field. */
export function assertToolOutputRuntime(userAgent: string | undefined): void {
  const version = userAgent?.match(/^[^/]+\/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\s|$)/);
  const parts = version?.slice(1, 4).map(Number);
  if (parts?.every(Number.isSafeInteger)) {
    const [major, minor, patch] = parts;
    if (major > 0 || minor > 151 || (minor === 151 && (patch > 0 || !version![4]))) return;
  }
  throw new TypeError("ExternalMessage/toolOutput requires a reported Codex CLI version >= 0.151.0 (not a prerelease of 0.151.0).");
}
