import { getApps, initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

// Firebase Console > Project settings > Your apps
const firebaseConfig = {
  apiKey: 'AIzaSyCGwMdYDs7K7m0aCSnlpmYXGLkGB1uvRPg',
  authDomain: 'english-class-88f8f.firebaseapp.com',
  databaseURL: 'https://english-class-88f8f-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'english-class-88f8f',
  storageBucket: 'english-class-88f8f.firebasestorage.app',
  messagingSenderId: '589630495891',
  appId: '1:589630495891:web:936cf841d351417eb20166',
  measurementId: 'G-QK7XD7XEKG',
}

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean)

let database = null

if (isFirebaseConfigured) {
  const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig)
  database = getDatabase(app)
}

export { database }
export default firebaseConfig
