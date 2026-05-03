import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initSupabase } from './supabaseClient.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const supabase = initSupabase();
const USERS_TABLE = 'users';

const validateUserPayload = (payload) => {
  const requiredFields = ['user_name', 'user_password', 'user_email'];
  const missing = requiredFields.filter((field) => !payload[field]);
  return {
    valid: missing.length === 0,
    missing,
  };
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Supabase backend is running' });
});

app.post('/api/users', async (req, res) => {
  const { user_name, user_password, user_email, date_of_birth, saved_stocks = [] } = req.body;
  const validation = validateUserPayload(req.body);

  if (!validation.valid) {
    return res.status(400).json({ error: 'Missing required fields', missing: validation.missing });
  }

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .insert([{ user_name, user_password, user_email, date_of_birth, saved_stocks }])
    .select()
    .single();

  if (error) {
    const status = error.code === '23505' ? 409 : 500;
    return res.status(status).json({ error: error.message });
  }

  return res.status(201).json(data);
});

app.post('/api/auth/login', async (req, res) => {
  const { user_email, user_password } = req.body;

  if (!user_email || !user_password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select('*')
    .eq('user_email', user_email)
    .single();

  if (error || !data || data.user_password !== user_password) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  return res.json(data);
});

app.get('/api/users/:email', async (req, res) => {
  const user_email = req.params.email;

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select('*')
    .eq('user_email', user_email)
    .single();

  if (error) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json(data);
});

app.put('/api/users/:email', async (req, res) => {
  const user_email = req.params.email;
  const updates = {};
  const allowed = ['user_name', 'user_password', 'date_of_birth', 'saved_stocks'];

  allowed.forEach((field) => {
    if (field in req.body) {
      updates[field] = req.body[field];
    }
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .update(updates)
    .eq('user_email', user_email)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json(data);
});

app.post('/api/users/:email/saved-stocks', async (req, res) => {
  const user_email = req.params.email;
  const { saved_stocks } = req.body;

  if (!Array.isArray(saved_stocks)) {
    return res.status(400).json({ error: 'saved_stocks must be an array' });
  }

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .update({ saved_stocks })
    .eq('user_email', user_email)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json(data);
});

app.post('/api/users/:email/save-stock', async (req, res) => {
  const user_email = req.params.email;
  const stockItem = req.body.stock;

  console.log('Save stock request:', { user_email, stockItem });

  if (!stockItem || typeof stockItem !== 'object' || !stockItem.symbol) {
    return res.status(400).json({ error: 'A valid stock object with a symbol is required.' });
  }

  const { data: userData, error: fetchError } = await supabase
    .from(USERS_TABLE)
    .select('saved_stocks')
    .eq('user_email', user_email)
    .single();

  console.log('Fetch user result:', { fetchError, userData });

  if (fetchError) {
    console.error('Fetch error:', fetchError);
    return res.status(404).json({ error: 'User not found', details: fetchError.message });
  }

  let currentSaved = [];
  if (userData.saved_stocks) {
    if (typeof userData.saved_stocks === 'string') {
      try {
        currentSaved = JSON.parse(userData.saved_stocks);
      } catch {
        currentSaved = [];
      }
    } else if (Array.isArray(userData.saved_stocks)) {
      currentSaved = userData.saved_stocks;
    }
  }
  
  const nextSaved = [stockItem, ...currentSaved.filter((stock) => stock?.symbol !== stockItem.symbol)].slice(0, 10);

  console.log('Updating with stocks:', nextSaved);

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .update({ saved_stocks: nextSaved })
    .eq('user_email', user_email)
    .select()
    .single();

  console.log('Update result:', { error, data });

  if (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: error.message, details: error });
  }

  return res.json(data);
});

app.use('/yahoo', async (req, res) => {
  try {
    const targetUrl = `https://query1.finance.yahoo.com${req.originalUrl.replace(/^\/yahoo/, '')}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: 'https://finance.yahoo.com',
    };

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
    });

    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const body = await response.text();
    return res.status(response.status).send(body);
  } catch (error) {
    console.error('Yahoo proxy error:', error);
    return res.status(500).json({ error: 'Yahoo proxy failed', details: error.message });
  }
});

// Proxy for ML Stock Recommender API
app.post('/api/recommend', async (req, res) => {
  try {
    const response = await fetch(`${process.env.API}/recommend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      throw new Error(`ML API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Recommendation service unavailable' });
  }
});

app.listen(port, () => {
  console.log(`Backend server listening on http://localhost:${port}`);
});

