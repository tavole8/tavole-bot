/**
 * Tavole v3 — Memory system module.
 *
 * Manages the 3-layer memory:
 *   Layer 1: Conversation history (handled by db.js saveMessage/getHistory)
 *   Layer 2: User profiles (extracted key facts)
 *   Layer 3: Project context (loaded from projects table)
 *
 * This module handles Layer 2 profile extraction and building
 * the full context payload for AI calls.
 */

import config from './config.js';
import {
  getUserProfile,
  saveUserProfile,
  getHistory,
  getActiveProjects,
  getUserMessageCount,
} from './db.js';

// Extract profile every N messages
const PROFILE_UPDATE_INTERVAL = 5;

/**
 * Check if we should update the user profile (every 5th message).
 */
export function shouldUpdateProfile(phone) {
  const count = getUserMessageCount(phone);
  // Update on every 5th message (5, 10, 15, ...)
  return count > 0 && count % PROFILE_UPDATE_INTERVAL === 0;
}

/**
 * Extract/update user profile by calling the AI with conversation + current profile.
 * Returns the updated profile object.
 */
export async function extractUserProfile(phone) {
  const currentProfile = getUserProfile(phone);
  const history = getHistory(phone, 30); // More context for extraction

  if (history.length < 3) {
    // Not enough conversation to extract meaningful profile
    return currentProfile;
  }

  const messages = history.map(m => `${m.role === 'user' ? 'Usuario' : 'Tavole'}: ${m.content}`).join('\n');

  const extractionPrompt = `Eres un extractor de perfil de usuario. Analiza la conversacion y el perfil actual, y devuelve un perfil JSON actualizado.

PERFIL ACTUAL:
${JSON.stringify(currentProfile, null, 2)}

CONVERSACION RECIENTE:
${messages}

Extrae y actualiza los siguientes campos (solo los que puedas inferir con confianza de la conversacion):
- name: nombre del usuario
- preferences: preferencias mencionadas (comida, estilo, etc)
- important_dates: fechas importantes (cumpleanos, aniversarios, etc)
- family_members: miembros de la familia mencionados
- medical_context: contexto medico si aplica
- active_interests: intereses o temas recurrentes
- location: ubicacion si la menciona
- business: informacion sobre su negocio si aplica
- notes: cualquier otro dato relevante

REGLAS:
- Conserva la informacion existente del perfil actual
- Solo agrega o actualiza lo que encuentres en la conversacion
- No inventes informacion
- Responde SOLO con el JSON, sin explicacion ni markdown

RESPUESTA (JSON):`;

  try {
    const baseUrl = (config.aiBaseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const isOpenRouter = baseUrl.includes('openrouter');

    let responseText;

    if (isOpenRouter) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.anthropicApiKey}`,
          'HTTP-Referer': 'https://tavole.ai',
          'X-Title': 'Tavole Profile Extraction',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3-5-haiku',
          max_tokens: 1024,
          messages: [{ role: 'user', content: extractionPrompt }],
        }),
      });

      if (!res.ok) {
        console.error('[memory] Profile extraction API error:', res.status);
        return currentProfile;
      }

      const data = await res.json();
      responseText = data.choices[0].message.content;
    } else {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1024,
          messages: [{ role: 'user', content: extractionPrompt }],
        }),
      });

      if (!res.ok) {
        console.error('[memory] Profile extraction API error:', res.status);
        return currentProfile;
      }

      const data = await res.json();
      responseText = data.content[0].text;
    }

    // Parse the JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[memory] Could not parse profile JSON from AI response');
      return currentProfile;
    }

    const newProfile = JSON.parse(jsonMatch[0]);

    // Merge with current profile (keep existing, update with new)
    const merged = { ...currentProfile, ...newProfile };

    // Remove empty/null values
    for (const key of Object.keys(merged)) {
      if (merged[key] === null || merged[key] === '' || merged[key] === undefined) {
        delete merged[key];
      }
    }

    saveUserProfile(phone, merged);
    console.log(`[memory] Profile updated for ${phone}:`, Object.keys(merged));

    return merged;
  } catch (err) {
    console.error('[memory] Profile extraction error:', err.message);
    return currentProfile;
  }
}

/**
 * Build the full memory context for an AI call.
 * Returns { profile, projects, conversationHistory, contextBlock }.
 */
export function buildMemoryContext(phone, historyLimit = 20) {
  const profile = getUserProfile(phone);
  const projects = getActiveProjects(phone);
  const history = getHistory(phone, historyLimit);

  let contextBlock = '';

  // Layer 2: User Profile
  if (Object.keys(profile).length > 0) {
    contextBlock += '\n\nCONTEXTO DEL USUARIO:\n';
    if (profile.name) contextBlock += `- Nombre: ${profile.name}\n`;
    if (profile.location) contextBlock += `- Ubicacion: ${profile.location}\n`;
    if (profile.business) contextBlock += `- Negocio: ${typeof profile.business === 'string' ? profile.business : JSON.stringify(profile.business)}\n`;
    if (profile.preferences) contextBlock += `- Preferencias: ${typeof profile.preferences === 'string' ? profile.preferences : JSON.stringify(profile.preferences)}\n`;
    if (profile.family_members) contextBlock += `- Familia: ${typeof profile.family_members === 'string' ? profile.family_members : JSON.stringify(profile.family_members)}\n`;
    if (profile.medical_context) contextBlock += `- Contexto medico: ${typeof profile.medical_context === 'string' ? profile.medical_context : JSON.stringify(profile.medical_context)}\n`;
    if (profile.active_interests) contextBlock += `- Intereses: ${typeof profile.active_interests === 'string' ? profile.active_interests : JSON.stringify(profile.active_interests)}\n`;
    if (profile.important_dates) contextBlock += `- Fechas importantes: ${typeof profile.important_dates === 'string' ? profile.important_dates : JSON.stringify(profile.important_dates)}\n`;
    if (profile.notes) contextBlock += `- Notas: ${profile.notes}\n`;
    contextBlock += 'Usa esta informacion para personalizar tus respuestas. Recuerda estos datos sin que el usuario tenga que repetirlos.\n';
  }

  // Layer 3: Active Projects
  if (projects.length > 0) {
    contextBlock += '\n\nPROYECTOS ACTIVOS DEL USUARIO:\n';
    for (const p of projects) {
      contextBlock += `- [${p.project_type}] ${p.project_name || 'Sin nombre'} (ID: ${p.id})`;
      if (p.credits_consumed > 0) contextBlock += ` — ${p.credits_consumed} creditos usados`;
      contextBlock += '\n';
      if (p.context && Object.keys(p.context).length > 0) {
        contextBlock += `  Contexto: ${JSON.stringify(p.context)}\n`;
      }
    }
    contextBlock += 'Referencia los proyectos activos naturalmente en la conversacion. Para actualizaciones menores a proyectos existentes, no pidas permiso.\n';
  }

  return { profile, projects, conversationHistory: history, contextBlock };
}
