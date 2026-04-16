import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiModel } from '../lib/plan-config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // VIP: gemini-2.0-flash（最上位モデル）を使用
  const model = genAI.getGenerativeModel({ model: getGeminiModel() });

  try {
    const { prompt } = req.body; // ユーザーからのメッセージを受け取る
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // AIの回答をアプリに返す
    res.status(200).json({ text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AIの呼び出しに失敗しました" });
  }
}