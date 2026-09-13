import { describe, expect, it } from 'vitest';

import { htmlToMarkdown } from './html-to-markdown.js';

describe('htmlToMarkdown', () => {
  it('emits the title as a leading heading', () => {
    const md = htmlToMarkdown('<html><head><title>My Page</title></head><body><p>hi</p></body></html>');
    expect(md.startsWith('# My Page')).toBe(true);
    expect(md).toContain('hi');
  });

  it('strips script and style subtrees entirely', () => {
    const md = htmlToMarkdown(
      '<body><script>alert(1)</script><style>.x{color:red}</style><p>visible</p></body>',
    );
    expect(md).not.toContain('alert');
    expect(md).not.toContain('color:red');
    expect(md).toContain('visible');
  });

  it('converts headings, paragraphs and lists', () => {
    const md = htmlToMarkdown('<h2>Section</h2><p>Body text.</p><ul><li>one</li><li>two</li></ul>');
    expect(md).toContain('## Section');
    expect(md).toContain('Body text.');
    expect(md).toContain('- one');
    expect(md).toContain('- two');
  });

  it('turns anchors into markdown links and drops empty/javascript hrefs', () => {
    const md = htmlToMarkdown(
      '<p><a href="https://ex.com/a">go</a> <a href="javascript:evil()">x</a> <a href="">y</a></p>',
    );
    expect(md).toContain('[go](https://ex.com/a)');
    expect(md).toContain('x'); // javascript: href reduced to its text
    expect(md).not.toContain('javascript:');
  });

  it('preserves pre/code as fenced blocks', () => {
    const md = htmlToMarkdown('<pre><code>const a = 1;</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('const a = 1;');
  });

  it('decodes common entities and collapses whitespace', () => {
    const md = htmlToMarkdown('<p>Tom &amp; Jerry&nbsp;&nbsp;   spaced</p>');
    expect(md).toContain('Tom & Jerry');
    expect(md).not.toContain('&amp;');
    expect(md).not.toMatch(/ {3,}/);
  });

  it('does not throw on malformed markup', () => {
    expect(() => htmlToMarkdown('<p>unclosed <b>bold <div>')).not.toThrow();
  });
});
