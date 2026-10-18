'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('fallback note editor removes text emoji without reparsing attributes or losing formatting', {
  skip: process.env.GP_SECURITY_BROWSER_TEST !== '1', timeout: 30000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<div id="editor" contenteditable></div>');
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const functions = ['stripEmoji', 'sanitizeScheduleNoteEditor'].map(name => {
      const start = source.indexOf(`function ${name}(`);
      const end = source.indexOf('\n}', start) + 2;
      assert.ok(start >= 0 && end > start, name);
      return source.slice(start, end);
    }).join('\n');
    await page.addScriptTag({ content: 'var scheduleNoteQuill=null, scheduleNoteSanitizing=false; var elements={scheduleNoteEditor:document.getElementById("editor")};\n' + functions });
    const result = await page.evaluate(() => {
      const editor = elements.scheduleNoteEditor;
      editor.innerHTML = '<p><b>Hallo 🫶 Welt</b> &amp; normal<br><span class="ql-size-large">Groß 😄</span><img o\u200Dnerror="window.__gpNoteInjected=1"></p>';
      const beforeImage = editor.querySelector('img');
      sanitizeScheduleNoteEditor();
      const afterImage = editor.querySelector('img');
      afterImage.dispatchEvent(new Event('error'));
      return { text: editor.textContent, sameNode: beforeImage === afterImage,
        activeHandler: afterImage.hasAttribute('onerror'), inertAttribute: afterImage.hasAttribute('o\u200Dnerror'),
        injected: window.__gpNoteInjected || 0, bold: editor.querySelector('b').textContent,
        sizeClass: editor.querySelector('span').className, breaks: editor.querySelectorAll('br').length };
    });
    assert.deepEqual(result, { text: 'Hallo  Welt & normalGroß ', sameNode: true, activeHandler: false,
      inertAttribute: true, injected: 0, bold: 'Hallo  Welt', sizeClass: 'ql-size-large', breaks: 1 });
    const caret = await page.evaluate(() => {
      const editor = elements.scheduleNoteEditor;
      editor.innerHTML = '<b>Hallo Welt</b>';
      const text = editor.firstChild.firstChild, selection = window.getSelection();
      selection.setBaseAndExtent(text, 5, text, 5);
      sanitizeScheduleNoteEditor();
      const unchanged = selection.anchorNode === text && selection.anchorOffset === 5 && selection.focusOffset === 5;
      editor.innerHTML = '<b>Hi🫶!</b><i>Bye😄!</i>';
      const first = editor.firstChild.firstChild, last = editor.lastChild.firstChild;
      selection.setBaseAndExtent(last, last.length, first, 2);
      sanitizeScheduleNoteEditor();
      return { unchanged, text: editor.textContent, anchorSame: selection.anchorNode === last,
        focusSame: selection.focusNode === first, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset };
    });
    assert.deepEqual(caret, { unchanged: true, text: 'Hi!Bye!', anchorSame: true, focusSame: true, anchorOffset: 4, focusOffset: 2 });
    assert.equal(await page.evaluate(() => {
      const editor = elements.scheduleNoteEditor;
      editor.textContent = 'Hi🫶';
      window.getSelection().setBaseAndExtent(editor.firstChild, 3, editor.firstChild, 3);
      sanitizeScheduleNoteEditor();
      return editor.textContent === 'Hi' && window.getSelection().anchorOffset === 2;
    }), true);
  } finally { await browser.close(); }
});
