import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, 'skills');

let registry = null;

/**
 * Load the skill registry from skills/index.json.
 * Caches after first load.
 */
export function loadSkillRegistry() {
  if (registry) return registry;
  try {
    const raw = readFileSync(join(SKILLS_DIR, 'index.json'), 'utf-8');
    registry = JSON.parse(raw);
    return registry;
  } catch (err) {
    console.error('[skills] Failed to load registry:', err.message);
    return { skills: [] };
  }
}

/**
 * Score a skill against a block of text.
 * Returns the number of keyword matches (case-insensitive).
 */
function scoreSkill(skill, text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of skill.keywords) {
    if (lower.includes(kw.toLowerCase())) {
      score++;
    }
  }
  return score;
}

/**
 * Find relevant skills based on the user's current message
 * and recent conversation history.
 *
 * @param {string} userMessage - The current message from the user.
 * @param {Array<{role: string, content: string}>} conversationHistory - Recent messages.
 * @returns {Array<{id: string, name: string, score: number}>} Top 2 matching skills.
 */
export function findRelevantSkills(userMessage, conversationHistory = []) {
  const reg = loadSkillRegistry();
  if (!reg.skills.length) return [];

  // Build combined text: current message + last 5 messages
  const recentMessages = conversationHistory.slice(-5);
  const combinedText = [
    userMessage,
    ...recentMessages.map((m) => m.content),
  ].join(' ');

  const scored = reg.skills
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      file: skill.file,
      score: scoreSkill(skill, combinedText),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return scored;
}

/**
 * Read the markdown content for a skill by its ID.
 *
 * @param {string} skillId - The skill ID from the registry.
 * @returns {string|null} The markdown content, or null if not found.
 */
export function getSkillContent(skillId) {
  const reg = loadSkillRegistry();
  const skill = reg.skills.find((s) => s.id === skillId);
  if (!skill) return null;

  try {
    return readFileSync(join(SKILLS_DIR, skill.file), 'utf-8');
  } catch (err) {
    console.error(`[skills] Failed to read skill file ${skill.file}:`, err.message);
    return null;
  }
}

/**
 * Format matched skills into a context block for the AI system prompt.
 *
 * @param {Array<{id: string, name: string, score: number}>} matchedSkills
 * @returns {string} Formatted context string to append to the system prompt.
 */
export function formatSkillContext(matchedSkills) {
  if (!matchedSkills.length) return '';

  const blocks = matchedSkills
    .map((skill) => {
      const content = getSkillContent(skill.id);
      if (!content) return '';
      return `\n\nSKILL DISPONIBLE - ${skill.name}:\n${content}\n\nUsa esta informacion para ayudar al usuario. Sigue los pasos documentados.`;
    })
    .filter(Boolean);

  return blocks.join('');
}
