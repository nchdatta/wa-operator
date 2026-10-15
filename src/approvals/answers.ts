const YES =
  /^(yes|yeah|yep|yup|ya|y|ok|okay|okk|k|sure|approve|approved|go|go ahead|do it|fine|allow|confirm|👍|✅|হ্যাঁ|হা|হুম|ঠিক আছে|আচ্ছা|করো|কর|ওকে)$/iu;
// "stop" / "থামো" are not here on purpose: they stop the whole job (and answer the open card with No).
const NO = /^(no|nope|nah|n|cancel|cancelled|don'?t|do not|reject|deny|❌|না|নাহ|বাদ দাও)$/iu;
const ALWAYS = /^(always|today|this task|remember|always allow|yes always|সবসময়)$/i;

/** A short typed answer to an approval card: a = approve, r = cancel, w = approve and remember. */
export function parseYesNo(text: string): 'a' | 'r' | 'w' | null {
  const t = text
    .trim()
    .replace(/\s+(please|pls|plz)$/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!t || t.length > 20) return null;
  return YES.test(t) ? 'a' : NO.test(t) ? 'r' : ALWAYS.test(t) ? 'w' : null;
}
