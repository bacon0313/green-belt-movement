import { createContext, useContext, useMemo, useState } from 'react'
import translations from './translations'

const LanguageContext = createContext(null)

function getValue(dictionary, key) {
  return key.split('.').reduce((value, part) => value?.[part], dictionary)
}

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState('en')

  const value = useMemo(() => ({
    language,
    setLanguage,
    toggleLanguage: () => setLanguage((current) => current === 'en' ? 'zh' : 'en'),
    t: (key, variables = {}) => {
      const value = getValue(translations[language], key) ?? getValue(translations.en, key) ?? key
      return Object.entries(variables).reduce(
        (text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)),
        value,
      )
    },
  }), [language])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) throw new Error('useLanguage must be used inside LanguageProvider')
  return context
}
