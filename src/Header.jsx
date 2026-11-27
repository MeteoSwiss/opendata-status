import React, {useEffect, useRef, useState} from 'react';

// Header as on opendatadocs.meteoswiss.ch (Docusaurus navbar): MeteoSwiss logo in the page language,
// title, on the right the documentation, GitHub and the language choice with full language names.
const LANGUAGES = {de: 'Deutsch', fr: 'Français', it: 'Italiano', en: 'English'};

export default function Header({locale, locales, onLocale, docsUrl, sourceUrl, t}) {
  const [open, setOpen] = useState(false);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (ev) => { if (!menu.current.contains(ev.target)) setOpen(false); };
    const onKey = (ev) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const choose = (l) => (ev) => { ev.preventDefault(); setOpen(false); onLocale(l); };
  return (
    <header className="navbar">
      <a className="navbar__brand" href="./" aria-label={t.home}>
        <img className="navbar__logo" src={`img/mch_logo_${locale}.png`} alt="MeteoSwiss - Logo" width="278" height="64" />
        <b className="navbar__title">Open Data Status <span className="beta">Beta</span></b>
      </a>
      <nav className="navbar__items" aria-label={t.nav}>
        <a className="navbar__link navbar__extra" href={docsUrl}>{t.docs}</a>
        <a className="navbar__link navbar__extra" href={sourceUrl} target="_blank" rel="noopener noreferrer">GitHub</a>
        <div className={`dropdown${open ? ' dropdown--open' : ''}`} ref={menu}>
          <button type="button" className="navbar__link dropdown__toggle" aria-haspopup="true" aria-expanded={open}
            aria-label={`${t.lang}: ${LANGUAGES[locale]}`} onClick={() => setOpen((o) => !o)}>
            {LANGUAGES[locale]}
          </button>
          <ul className="dropdown__menu">
            {locales.map((l) => (
              <li key={l}>
                <a className={`dropdown__link${l === locale ? ' dropdown__link--active' : ''}`} href={`?lang=${l}`}
                  hrefLang={l} lang={l} aria-current={l === locale ? 'true' : undefined} onClick={choose(l)}>
                  {LANGUAGES[l]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </header>
  );
}
