import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import OgdMonitor from './OgdMonitor';
import './page.css';

// Page frame: title, intro, language choice. Language from ?lang=, else browser language, else German.
const LOCALES = ['de', 'fr', 'it', 'en'];
const PAGE = {
  de: {intro: 'Wie aktuell die offenen Daten von MeteoSchweiz auf der STAC API der Bundes-Geodateninfrastruktur verfügbar sind.', docs: 'Dokumentation', source: 'Quellcode', lang: 'Sprache'},
  fr: {intro: 'Actualité des données ouvertes de MeteoSuisse disponibles sur l’API STAC de l’infrastructure fédérale de données géographiques.', docs: 'Documentation', source: 'Code source', lang: 'Langue'},
  it: {intro: 'Quanto sono aggiornati i dati aperti di MeteoSvizzera disponibili sull’API STAC dell’infrastruttura federale dei dati geografici.', docs: 'Documentazione', source: 'Codice sorgente', lang: 'Lingua'},
  en: {intro: 'How up to date the MeteoSwiss open data are on the STAC API of the Federal Spatial Data Infrastructure.', docs: 'Documentation', source: 'Source code', lang: 'Language'},
};
const DOCS = {de: 'https://opendatadocs.meteoswiss.ch/de', fr: 'https://opendatadocs.meteoswiss.ch/fr', it: 'https://opendatadocs.meteoswiss.ch/it', en: 'https://opendatadocs.meteoswiss.ch'};

function initialLocale() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LOCALES.includes(q)) return q;
  const b = (navigator.language || '').slice(0, 2);
  return LOCALES.includes(b) ? b : 'de';
}

function App() {
  const [locale, setLocale] = useState(initialLocale);
  const p = PAGE[locale];
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const choose = (l) => (ev) => {
    ev.preventDefault();
    const u = new URL(location.href);
    u.searchParams.set('lang', l);
    history.replaceState(null, '', u);
    setLocale(l);
  };
  return (
    <>
      <main className="page">
        <h1>Open Data Status <span className="beta">Beta</span></h1>
        <p className="intro">{p.intro}</p>
        <OgdMonitor key={locale} locale={locale} />
      </main>
      <footer className="page footer">
        <nav aria-label={p.lang}>
          {LOCALES.map((l) => (l === locale
            ? <strong key={l}>{l.toUpperCase()}</strong>
            : <a key={l} href={`?lang=${l}`} hrefLang={l} onClick={choose(l)}>{l.toUpperCase()}</a>))}
        </nav>
        <span><a href={DOCS[locale]}>{p.docs}</a> · <a href={window.SOURCE_URL || '#'}>{p.source}</a></span>
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
