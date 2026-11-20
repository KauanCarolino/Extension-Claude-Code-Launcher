'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanSkills, createSkill, setSkillEnabled, parseFrontmatter } = require('../out/skills.js');

test('frontmatter, criação, desativação e skill quebrada', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  try {
    assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "b c"\n---\n'), { name: 'a', description: 'b c' });
    await createSkill(root, 'minha-skill', 'Usar quando "x"');
    await assert.rejects(createSkill(root, 'minha-skill', ''));
    await assert.rejects(createSkill(root, '../fora', ''));
    fs.symlinkSync(path.join(root, 'nao-existe'), path.join(root, 'quebrada'));
    let list = await scanSkills(root, 'global');
    assert.deepEqual(list.map((s) => [s.name, s.state]), [['minha-skill', 'active'], ['quebrada', 'broken']]);
    assert.equal(list[0].description, 'Usar quando "x"');
    await setSkillEnabled(list[0], false);
    list = await scanSkills(root, 'global');
    assert.equal(list[0].state, 'disabled');
    await setSkillEnabled(list[0], true);
    assert.equal((await scanSkills(root, 'global'))[0].state, 'active');
    assert.deepEqual(await scanSkills(path.join(root, 'x'), 'project'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
