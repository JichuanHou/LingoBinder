import { GoogleGenAI, Type } from "@google/genai";
import { TargetLanguage } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is missing from environment variables.");
  }
  return new GoogleGenAI({ apiKey });
};

export const translateSegmentsBatch = async (
  texts: string[],
  targetLanguage: TargetLanguage
): Promise<string[]> => {
  try {
    const ai = getAiClient();
    
    // We use a schema to ensure the output is exactly a list of strings matching the input length
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
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

    const jsonText = response.text;
    if (!jsonText) return texts.map(() => "Translation Error");

    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      return parsed as string[];
    }
    
    return texts.map(() => "Translation Format Error");

  } catch (error) {
    console.error("Gemini Translation Error:", error);
    // Fallback to returning original text with error marker if API fails
    return texts.map((t) => `[Error] ${t}`);
  }
};