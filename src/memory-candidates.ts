import { safeSourceText, userText, type SourceItem } from "./memory-sources";

const oneOff = /\b(?:just (?:this|for)|this time|for (?:now|today|this (?:task|session|run|request|PR))|today only|this once)\b|(?:이번(?:에|만|에는| 작업| 요청| 세션| 한 번)|오늘만|일단|지금만)/i;
const speculative = /\?\s*$|\b(?:maybe|perhaps|I wonder|might|seems? to)\b|(?:일지도|아마|것 같|어떨까|일까요)/i;
const preference = /\b(?:I (?:usually |generally )?prefer|we prefer|my preference is|from now on|going forward|by default|as a rule|remember (?:that|to)|always (?:use|run|write|keep|include|prefer|check|ask|respond|reply|answer|format|send|create|avoid|show|test|start|commit|open|set)|never (?:use|run|write|include|commit|send|push|change|delete|share)|(?:we|I) (?:always|never)\b)|(?:선호(?:해|한다|합니다)|기억해\s*(?:줘|두|주세요)|(?:우리|내) (?:원칙|규칙)(?:은|으로))/i;
const recurringRequest = /(?:앞으로(?:는|도)?|다음부터|기본(?:으로|값은|값으로| 방침)|항상|언제나|매번)/;
const instruction = /(?:해|써|줘|두|말아|말자|말고|하지 마|하세요|주세요|합니다|한다|하자|쓴다|사용|적용|작성|선택|실행|정리|확인|지켜|대신|유지|답변|응답|으로 설정)/;
const decision = /\b(?:we (?:chose|decided|use|adopted|standardized on)|I (?:chose|decided)|(?:our|the) team (?:chose|uses|decided))\b|(?:선택|채택|결정|통일|표준으로|쓰기로|사용하기로)/i;
const reason = /\b(?:because|so that|due to|in order to|since|this avoids|this prevents|this lets)\b|(?:이유는|왜냐하면|때문|위해서|위해|하므로|어서|라서|으므로)/i;
const verifiedFix = /\b(?:fixes|resolves|fixed|resolved)\b|(?:해결(?:된다|됐다|됐|됨|했|된|되었|됩)|고쳐졌)/i;
const recurringCondition = /\b(?:when|whenever|if|every time|on .+? (?:builds|starts|runs))\b|(?:할 때|날 때|발생하면|나면|경우|뜨면|마다)/i;
const success = /\b(?:confirmed|verified|reproduced|tested)\b|(?:검증|확인|재현)/i;
const correction = /\b(?:this (?:repo(?:sitory)?|project)|our team)\b.*\b(?:instead of|rather than|requires)\b|\b(?:instead of|rather than)\b.*\b(?:this (?:repo(?:sitory)?|project)|our team)\b|\b(?:our|the project(?:'s)?|this repo(?:sitory)?(?:'s)?|team) (?:rule|convention|standard|policy) (?:is|requires)|(?:우리 팀|이 (?:프로젝트|저장소)).*(?:말고|대신|사용하지 않|쓰지 않)/i;

function enduring(statement: string) {
  if (oneOff.test(statement) || speculative.test(statement) || /^(?:>|example\b|예시|예를 들)/i.test(statement)) return false;
  return preference.test(statement) || correction.test(statement) ||
    (recurringRequest.test(statement) && instruction.test(statement)) ||
    (decision.test(statement) && reason.test(statement)) ||
    (verifiedFix.test(statement) && recurringCondition.test(statement) && success.test(statement));
}

function inferScope(statement: string) {
  if (/\b(?:across|in|for) (?:all|every|each) (?:my |our )?(?:projects?|repos?|repositories|repository)\b|(?:모든|전체) (?:프로젝트|저장소)(?:에서|에| 공통)/i.test(statement)) return "global";
  if (/\b(?:our|the|my) (?:whole )?team\b|\bteam[- ]wide\b|(?:우리\s*팀|팀 전체|팀 공통|그룹 전체|그룹 공통)/i.test(statement)) return "group";
}

function statements(turn: string): string[] {
  const text = userText(turn);
  if (!text || /<(?:INSTRUCTIONS|user_query|conversation_summary|system_instruction|tool_response)\b|^# (?:AGENTS|GEMINI|CLAUDE)\.md\b|^(?:system|assistant|tool):|^\s*(?:examples?|예시|예제)\s*:/im.test(text)) return [];
  const rationale = /^(?:because|since |this (?:avoids|prevents|lets)|(?:we |I )?(?:confirmed|verified|tested)|이유는|왜냐하면|확인했|검증했)/i;
  const result: string[] = [];
  let fenced = false;
  let paragraph = "";
  function finish() {
    if (!paragraph) return;
    // A following rationale or confirmation belongs to the same decision or fix.
    const sentences = paragraph.split(/(?<=[.!?。])\s+(?=[\p{L}\p{N}\x60])/u);
    let previous = "";
    for (const sentence of sentences) {
      if (previous && rationale.test(sentence)) {
        previous += " " + sentence;
      } else {
        if (previous && enduring(previous)) result.push(previous);
        previous = sentence;
      }
    }
    if (previous && enduring(previous)) result.push(previous);
    paragraph = "";
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) { finish(); fenced = !fenced; continue; }
    if (fenced || /^\s*(?:>|#|<|\{)/.test(line)) { finish(); continue; }
    const trimmed = line.trim();
    const bullet = /^(?:[-*•]|\d+[.)])\s+/;
    if (!trimmed || bullet.test(trimmed) || (!rationale.test(trimmed) && (enduring(paragraph) || /[.!?。]$/.test(paragraph)))) finish();
    if (trimmed) paragraph += (paragraph ? " " : "") + trimmed.replace(bullet, "");
  }
  finish();
  return result;
}

export function prepareCandidates(items: readonly SourceItem[]): SourceItem[] {
  const result: SourceItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!safeSourceText(item.body) || !safeSourceText(item.source) || (item.title && !safeSourceText(item.title))) continue;
    const bodies = item.kind === "memory" ? [item.body.trim()] : statements(item.body);
    for (const body of bodies) {
      const explicitScope = inferScope(body);
      const scope = item.kind === "conversation" ? explicitScope ?? item.suggestedScope : item.suggestedScope ?? explicitScope;
      const key = JSON.stringify([item.folder ?? (scope === "global" ? "" : item.source.split("#")[0]), scope, body.normalize("NFC").replace(/\s+/g, " ").trim()]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...item, body, ...(scope && { suggestedScope: scope }) });
    }
  }
  return result;
}
