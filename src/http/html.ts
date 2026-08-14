/**
 * A tiny auto-escaping HTML template.
 *
 * Every interpolated value is escaped unless it is explicitly wrapped in `raw()`. That
 * polarity is the point: the review inbox renders caption text that came from a stranger's
 * Instagram post, so the safe path has to be the default and the unsafe one has to be typed
 * out on purpose.
 *
 * Replaces JSX — see the revision note in docs/adr/0011-frontend-server-rendered-no-framework.md.
 */

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** Mark a string as already-safe HTML. The only way to bypass escaping. */
export function raw(value: string): Html {
  return new Html(value);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new Html(out);
}

/** Conditional fragment, so templates do not need ternaries returning empty strings. */
export function when(condition: unknown, fragment: () => Html): Html | null {
  return condition ? fragment() : null;
}
