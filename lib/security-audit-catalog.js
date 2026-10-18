'use strict';
const source = require('./security-audits/asvs-5.0.0.json');
const CATALOG = Object.freeze(source.Requirements.flatMap(chapter => chapter.Items.flatMap(section =>
  section.Items.map(item => Object.freeze({
    id: `v5.0.0-${item.Shortcode.slice(1)}`, chapterId: chapter.Shortcode,
    chapter: chapter.Name, section: section.Name, title: item.Description, level: Number(item.L),
  })))));
const STANDARD = Object.freeze({
  name: 'OWASP ASVS', version: '5.0.0', targetLevel: 2, requirementCount: CATALOG.length,
  sourceUrl: 'https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release',
  catalogSha256: 'bcdbec214d70abcfad9284a31d4f9e5134305831d628aad3aa85d7e26626cb35',
  license: 'CC-BY-SA-4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'OWASP Foundation and ASVS contributors. Unmodified English ASVS 5.0.0 release catalogue; GP assessments are separate.',
});
module.exports = { CATALOG, STANDARD };
