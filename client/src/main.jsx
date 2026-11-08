import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/baloo-2';
import App from './App.jsx';
import './styles/base.css';
import './styles/shop.css';
import './styles/admin.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
