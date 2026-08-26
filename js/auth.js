/**
 * MEDUSINO — auth.js
 * Autenticazione con Firebase (email REALE + password)
 *
 * Flusso registrazione:
 *   1. Utente compila form (nome, cognome, telefono, password)
 *   2. Viene creato un account Firebase Auth
 *   3. Viene creato un doc Firestore partecipanti/{uid} con approvato: false
 *   4. L'utente vede la schermata "In attesa di approvazione"
 *   5. Un admin approva dal pannello → approvato: true
 *   6. L'utente può accedere normalmente
 */

import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const auth = () => window._firebase.auth;
const db   = () => window._firebase.db;

// Cache utente corrente
let _utente = null;

// ── LOGIN ─────────────────────────────────────────────
/**
 * Login con email (o slug nome.cognome) e password.
 * Accetta sia l'email completa sia lo slug nome.cognome.
 */
export async function initAuth(email, password) {
  await signInWithEmailAndPassword(auth(), email.trim().toLowerCase(), password);
}

// ── REGISTRAZIONE ─────────────────────────────────────
/**
 * Registra un nuovo partecipante.
 * Crea account Firebase Auth + documento Firestore con approvato: false.
 *
 * @param {string} nome
 * @param {string} cognome
 * @param {string} telefono
 * @param {string} password
 * @returns {{ email: string }} — email generata, per conferma UI
 */
export async function registra(nome, cognome, email, telefono, password, nickname = '') {
  const emailClean = email.trim().toLowerCase();

  // Crea utente Firebase Auth con l'email reale fornita
  const cred = await createUserWithEmailAndPassword(auth(), emailClean, password);
  const uid  = cred.user.uid;

  // Salva profilo Firestore in stato "in attesa"
  await setDoc(doc(db(), 'partecipanti', uid), {
    nome:        nome.trim(),
    cognome:     cognome.trim(),
    nickname:    nickname.trim() || nome.trim(),
    telefono:    telefono.trim(),
    email:       emailClean,
    isAdmin:     false,
    isOwner:     false,
    approvato:   false,
    disabilitato: false,
    richiestaAt: serverTimestamp(),
  });

  return { email: emailClean };
}

// ── AUTH STATE ────────────────────────────────────────
/**
 * Ascolta i cambi di stato auth.
 * Callback riceve:
 *   - { ...utente }             se autenticato e approvato
 *   - { ...utente, approvato: false }  se in attesa di approvazione
 *   - null                      se non autenticato o profilo non trovato
 */
export function onAuthChange(callback) {
  onAuthStateChanged(auth(), async (firebaseUser) => {
    if (!firebaseUser) {
      _utente = null;
      callback(null);
      return;
    }

    const uid  = firebaseUser.uid;
    const snap = await getDoc(doc(db(), 'partecipanti', uid));

    if (!snap.exists()) {
      _utente = null;
      callback(null);
      return;
    }

    const data = snap.data();
    _utente = {
      id:           uid,
      nome:         data.nome,
      cognome:      data.cognome  || '',
      nickname:     data.nickname || data.nome || '',
      telefono:     data.telefono || '',
      email:        data.email    || '',
      isAdmin:      data.isAdmin  === true,
      isOwner:      data.isOwner  === true,
      approvato:    data.approvato === true,
      disabilitato: data.disabilitato === true,
    };

    callback(_utente);
  });
}

export function getCurrentUser() {
  return _utente;
}


export async function logout() {
  await signOut(auth());
}

// ── HELPERS ───────────────────────────────────────────
/**
 * Trasforma una stringa in slug sicuro per email:
 * "Àlì" → "ali", "De Rossi" → "de.rossi"
 */
function _slug(str) {
  return str
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // rimuove diacritici
    .replace(/\s+/g, '.')              // spazi → punto
    .replace(/[^a-z0-9.]/g, '');      // rimuove caratteri non validi
}
