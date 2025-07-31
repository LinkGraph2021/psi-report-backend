import express from 'express';
import multer from 'multer';
import fs from 'fs';
import cors from 'cors';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

app.post('/generate-report', upload.any(), async (req, res) => {
  try {
    const fields = req.body;
    const files = req.files;

    // Organize images by field name (take1_mobile, take2_desktop, etc.)
    const imageGroups = {};
    for (const file of files) {
      const key = file.fieldname;
      if (!imageGroups[key]) imageGroups[key] = [];
      imageGroups[key].push(file);
    }

    // Build list of image files for prompt
    const fileHandles = [];
    for (const group of Object.values(imageGroups)) {
      for (const file of group) {
        const f = await openai.files.create({
          file: fs.createReadStream(file.path),
          purpose: 'assistants',
        });
        fileHandles.push(f);
      }
    }

    // Prepare user prompt for GPT-4
    const systemPrompt = `You're an analyst creating a detailed PSI performance report from screenshots.
1. Detect the analyzed URL and date (use provided fields if given).
2. Extract and compare core metrics (Overall, FCP, LCP, INP, CLS, TTFB).
3. Build a comparison table like this:

               Take | Overall | FCP | LCP | INP | CLS | TTFB
Mobile         1
               2
               3
Desktop        1
               2
               3

4. Generate an image grid: mobile screenshots on top, desktop below.
5. Provide a short summary of insights.
Output everything in a downloadable .docx file.`;

    // Create assistant thread
    const thread = await openai.beta.threads.create();

    const message = await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: [
        `Create a performance report using these screenshots.`,
        `Optional URL: ${fields.url || 'Extract from images'}`,
        `Optional date: ${fields.date || 'Today'}`,
      ].join('\n'),
      file_ids: fileHandles.map(f => f.id),
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: 'your-assistant-id-here',
    });

    // Poll until run is complete
    let result;
    while (true) {
      result = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      if (result.status === 'completed') break;
      if (result.status === 'failed') throw new Error('Run failed');
      await new Promise(r => setTimeout(r, 2000));
    }

    // Get final response message
    const messages = await openai.beta.threads.messages.list(thread.id);
    const finalMsg = messages.data.find(m => m.role === 'assistant');

    const fileAttachment = finalMsg.file_ids?.[0];
    if (!fileAttachment) throw new Error('No file returned');

    const file = await openai.files.retrieveContent(fileAttachment);
    res.setHeader('Content-Disposition', 'attachment; filename=report.docx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    file.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate report' });
  } finally {
    // Clean up uploaded files
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
