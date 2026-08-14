import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw, when } from '../../src/http/html.ts';

describe('html template', () => {
  it('escapes interpolated values by default', () => {
    const evil = '<script>alert(1)</script>';
    expect(html`<p>${evil}</p>`.toString()).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes quotes so attribute injection is not possible', () => {
    const evil = '" onload="alert(1)';
    expect(html`<img alt="${evil}">`.toString()).toBe('<img alt="&quot; onload=&quot;alert(1)">');
  });

  it('escapes single quotes too', () => {
    expect(html`<p>${"it's"}</p>`.toString()).toBe('<p>it&#39;s</p>');
  });

  it('does not double-escape nested templates', () => {
    const inner = html`<em>${'a & b'}</em>`;
    expect(html`<p>${inner}</p>`.toString()).toBe('<p><em>a &amp; b</em></p>');
  });

  it('joins arrays, escaping each element', () => {
    const rows = ['a<b', 'c&d'];
    expect(html`<ul>${rows.map((r) => html`<li>${r}</li>`)}</ul>`.toString()).toBe(
      '<ul><li>a&lt;b</li><li>c&amp;d</li></ul>',
    );
  });

  it('renders null, undefined, and false as nothing', () => {
    expect(html`<p>${null}${undefined}${false}</p>`.toString()).toBe('<p></p>');
  });

  it('renders zero, which is falsy but meaningful', () => {
    expect(html`<p>${0}</p>`.toString()).toBe('<p>0</p>');
  });

  it('lets raw() through unescaped, as the explicit opt-out', () => {
    expect(html`<div>${raw('<br>')}</div>`.toString()).toBe('<div><br></div>');
  });

  it('handles a template with no interpolations', () => {
    expect(html`<p>hello</p>`.toString()).toBe('<p>hello</p>');
  });

  it('handles a value at the very end', () => {
    expect(html`a${'b'}`.toString()).toBe('ab');
  });
});

describe('when', () => {
  it('renders the fragment for truthy conditions', () => {
    expect(when(true, () => html`<b>yes</b>`)?.toString()).toBe('<b>yes</b>');
  });

  it('renders nothing for falsy conditions', () => {
    expect(when(false, () => html`<b>no</b>`)).toBeNull();
    expect(html`<p>${when(0, () => html`x`)}</p>`.toString()).toBe('<p></p>');
  });
});

describe('escapeHtml', () => {
  it('escapes all five significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Why Planes Really Fly — Veritasium')).toBe(
      'Why Planes Really Fly — Veritasium',
    );
  });
});
