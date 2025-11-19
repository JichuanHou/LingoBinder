
import { GoogleGenAI, Type } from "@google/genai";
import { TargetLanguage, AISettings } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is missing from environment variables.");
  }
  return new GoogleGenAI({ apiKey });
};

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    return reject(new Error("Aborted"));
  }
  
  const timer = setTimeout(() => {
    resolve();
  }, ms);

  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new Error("Aborted"));
  });
});

/**
 * Translate using Google Gemini SDK
 */
const translateWithGemini = async (
  texts: string[],
  targetLanguage: TargetLanguage,
  modelName: string,
  signal?: AbortSignal
): Promise<string[]> => {
  const ai = getAiClient();
  
  // Ensure we use a valid Gemini model name
  const safeModel = modelName.includes('gemini') ? modelName : "gemini-2.5-flash";

  const response = await ai.models.generateContent({
    model: safeModel,
    contents: `Translate the following array of text segments into ${targetLanguage}. 
    Maintain the tone and nuance of the original text. 
    Do not merge segments. Return strictly an array of translated strings in the same order.
    
    Input Segments:
    ${JSON.stringify(texts)}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.STRING
        }
      }
    }
  });

  // Check abort after response
  if (signal?.aborted) throw new Error("Aborted");

  const jsonText = response.text;
  if (!jsonText) return texts.map(() => "Translation Error");

  const parsed = JSON.parse(jsonText);
  if (Array.isArray(parsed)) {
    return parsed as string[];
  }
  
  throw new Error("Invalid JSON format from Gemini");
};

/**
 * Translate using OpenAI Compatible Endpoint (Custom)
 */
const translateWithOpenAI = async (
  texts: string[],
  targetLanguage: TargetLanguage,
  settings: AISettings,
  signal?: AbortSignal
): Promise<string[]> => {
  if (!settings.apiKey && !settings.baseUrl.includes('localhost')) {
    throw new Error("API Key required for OpenAI compatible endpoints");
  }

  const prompt = `You are a professional translator. Translate the following JSON array of text segments into ${targetLanguage}.
  Maintain the tone and nuance.
  IMPORTANT: Return ONLY a raw JSON array of strings. No markdown formatting, no backticks.
  Example: ["Hello", "World"]
  
  Input:
  ${JSON.stringify(texts)}`;

  const body = {
    model: settings.model || "gpt-3.5-turbo",
    messages: [
      { role: "system", content: "You are a translator. Output strictly JSON array." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3
  };

  // Clean URL
  let url = settings.baseUrl.replace(/\/+$/, '');
  if (!url.endsWith('/chat/completions')) {
      url += '/chat/completions';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API Error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) throw new Error("No content in OpenAI response");

  // Clean potential markdown code blocks ```json ... ```
  const cleanJson = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleanJson);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
    throw new Error("Parsed content is not an array");
  } catch (e) {
    console.error("Failed to parse OpenAI JSON", content);
    throw new Error("JSON Parse Error from OpenAI response");
  }
};

export const translateSegmentsBatch = async (
  texts: string[],
  targetLanguage: TargetLanguage,
  settings: AISettings,
  signal?: AbortSignal
): Promise<string[]> => {
  let retries = 0;
  const maxRetries = 3;
  let backoff = 2000; 

  while (retries <= maxRetries) {
    if (signal?.aborted) throw new Error("Aborted");

    try {
      if (settings.provider === 'openai') {
        return await translateWithOpenAI(texts, targetLanguage, settings, signal);
      } else {
        return await translateWithGemini(texts, targetLanguage, settings.model, signal);
      }
    } catch (error: any) {
      if (signal?.aborted || error.message === "Aborted" || error.name === 'AbortError') {
        throw new Error("Aborted");
      }

      const isRateLimit = 
        error.status === 429 || 
        error.code === 429 || 
        (error.message && (
          error.message.includes("429") || 
          error.message.includes("quota") || 
          error.message.includes("RESOURCE_EXHAUSTED")
        )) ||
        error.status === 503;

      if (isRateLimit) {
        if (retries === maxRetries) break;
        console.warn(`Rate limit hit (${settings.provider}). Retrying in ${backoff}ms...`);
        try {
          await delay(backoff, signal);
        } catch (e) {
          if ((e as Error).message === "Aborted") throw e;
        }
        backoff = Math.min(backoff * 1.5, 30000);
        retries++;
        continue;
      }

      console.error("Translation Error:", error);
      // Return error strings for UI
      return texts.map(() => "[Translation Failed]");
    }
  }

  return texts.map(() => "[Error: Retry Limit Exceeded]");
};
