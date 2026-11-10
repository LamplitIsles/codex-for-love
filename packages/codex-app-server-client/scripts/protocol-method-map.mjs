export function parseProtocolMethodMap(source) {
  return {
    methods: parseRequestDefinitions(source, "client_request_definitions!"),
    serverRequests: parseRequestDefinitions(source, "server_request_definitions!"),
  };
}

function parseRequestDefinitions(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);
  if (markerIndex < 0) throw new Error(`${marker} was not found.`);
  const open = sourceText.indexOf("{", markerIndex + marker.length);
  if (open < 0) throw new Error(`${marker} has no body.`);

  const methods = [];
  let entryStart = open + 1;
  let depth = 1;
  for (let index = open + 1; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (character === "{") {
      if (depth === 1) {
        const header = sourceText.slice(entryStart, index).trim();
        const match = header.match(/([A-Za-z][A-Za-z0-9]*)(?:\s*=>\s*"([^"]+)")?\s*$/);
        if (!match) throw new Error(`Unable to parse request header: ${header}`);
        const close = matchingBrace(sourceText, index);
        const body = sourceText.slice(index + 1, close);
        const response = body.match(/^\s*response:\s*([^,]+),/m)?.[1]?.trim();
        if (!response) throw new Error(`Request ${match[1]} has no response type.`);
        methods.push({
          method: match[2] ?? lowerCamelCase(match[1]),
          response: typescriptType(response),
          variant: match[1],
        });
        index = close;
        const comma = sourceText.indexOf(",", close);
        if (comma < 0) throw new Error(`Request ${match[1]} is not comma-terminated.`);
        entryStart = comma + 1;
        index = comma;
        continue;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return methods;
}

function matchingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unterminated request definition.");
}

function typescriptType(rustType) {
  const parts = rustType.split("::");
  const name = parts.at(-1);
  const scope = parts.length > 1 && parts[0] === "v2" ? "v2" : "root";
  return { module: scope === "v2" ? `v2/${name}` : name, name };
}

function lowerCamelCase(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}
