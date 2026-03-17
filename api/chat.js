import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // POSTリクエスト（データの送信）以外は受け付けない設定
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // 先ほど設定した環境変数（GEMINI_API_KEY）を呼び出す
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  // 使うモデルを指定（爆速で安価な 1.5-flash を選択）
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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