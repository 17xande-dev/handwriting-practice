package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
	"calligraphy/internal/history"
)

// The JSON API the web app and the iPad app sync through. A browser
// authenticates with its session cookie, the app with
// "Authorization: Bearer <token>" from POST /api/token. The wire format is
// documented in docs/sync-api.md, which the iPad client is written against.

const (
	// maxSyncBody bounds one sync request. A first sync of a long history is
	// the largest: 2000 runs of each kind at a few KB.
	maxSyncBody = 16 << 20
	// pullLimit is how many changes one response carries; the client asks
	// again while "more" is true.
	pullLimit = 1000
	// pullBytes caps the record data in one response, so a page of large
	// records stays a few MB however few of them there are.
	pullBytes = 4 << 20
	// maxPush caps the records (across both kinds) and the deletions in one
	// request. Bigger first syncs are sent in several requests.
	maxPush = 1000
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// bearer returns the token from an Authorization: Bearer header, or "".
func bearer(r *http.Request) string {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

// errNotSignedIn means the request has no live credentials (401). Any other
// error from apiUser is a server fault (500): clients treat 401 as "this token
// is dead" and throw it away, so a passing database error must not become one.
var errNotSignedIn = errors.New("not signed in")

// apiUser authenticates an API request by bearer token or, failing that,
// the browser's cookie.
func (s *Server) apiUser(r *http.Request) (account.User, account.Session, error) {
	tok := bearer(r)
	if tok == "" {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			return account.User{}, account.Session{}, errNotSignedIn
		}
		tok = c.Value
	}
	u, sess, err := s.accounts.Authenticate(r.Context(), tok)
	if errors.Is(err, account.ErrNotFound) {
		return account.User{}, account.Session{}, errNotSignedIn
	}
	if err != nil {
		s.log.Error("authenticate", "err", err)
		return account.User{}, account.Session{}, err
	}
	return u, sess, nil
}

func (s *Server) requireAPIUser(next func(http.ResponseWriter, *http.Request, account.User, account.Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		u, sess, err := s.apiUser(r)
		if errors.Is(err, errNotSignedIn) {
			apiError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		if err != nil {
			apiError(w, http.StatusInternalServerError, "server error")
			return
		}
		next(w, r, u, sess)
	}
}

func (s *Server) apiMe(w http.ResponseWriter, r *http.Request, u account.User, _ account.Session) {
	writeJSON(w, http.StatusOK, map[string]string{"email": u.Email})
}

// apiToken signs the app in. It shares checkPassword and the sign-in rate
// limits with the web form, so it is no softer a target.
func (s *Server) apiToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Label    string `json:"label"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		apiError(w, http.StatusBadRequest, "expected {email, password, label}")
		return
	}
	email, err := account.NormalizeEmail(req.Email)
	if err != nil {
		apiError(w, http.StatusBadRequest, "email is not a valid address")
		return
	}
	if !s.allowLogin(r, email) {
		apiError(w, http.StatusTooManyRequests, "too many attempts; wait a minute")
		return
	}
	u, err := s.checkPassword(r, email, req.Password)
	if errors.Is(err, errBadCredentials) {
		apiError(w, http.StatusUnauthorized, loginFailed)
		return
	}
	if errors.Is(err, auth.ErrBusy) {
		w.Header().Set("Retry-After", "5")
		apiError(w, http.StatusServiceUnavailable, "the server is busy; try again in a few seconds")
		return
	}
	if err != nil {
		s.serverError(w, err)
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = "An app"
	}
	token, _, err := s.accounts.CreateSession(r.Context(), u.ID, account.KindDevice, label)
	if err != nil {
		s.serverError(w, err)
		return
	}
	s.accounts.RecordLogin(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, map[string]string{"token": token, "email": u.Email})
}

// apiTokenDelete signs the app out: its token stops working at once.
func (s *Server) apiTokenDelete(w http.ResponseWriter, r *http.Request, u account.User, sess account.Session) {
	if err := s.accounts.Revoke(r.Context(), u.ID, sess.ID); err != nil {
		s.serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type syncRequest struct {
	// Account is the email the client believes it is signed in as. Optional
	// on the wire, but the web and iPad clients always send it: a shared
	// browser whose cookie now belongs to someone else must not push the
	// previous person's history into that account.
	Account string                       `json:"account"`
	Cursor  int64                        `json:"cursor"`
	Push    map[string][]json.RawMessage `json:"push"`
	Deleted []history.Ref                `json:"deleted"`
}

type syncResponse struct {
	Cursor  int64                        `json:"cursor"`
	Records map[string][]json.RawMessage `json:"records"`
	Deleted []history.Ref                `json:"deleted"`
	More    bool                         `json:"more"`
	// Rejected lists pushed runs the server refused, so the client can stop
	// resending them rather than retry for ever.
	Rejected []rejected `json:"rejected"`
}

type rejected struct {
	Kind   string `json:"kind"`
	ID     string `json:"id,omitempty"`
	Reason string `json:"reason"`
}

// apiSync pushes the client's new runs and deletions, then returns
// everything after its cursor. One round trip does both; the client repeats
// with the new cursor (and nothing to push) while "more" is true.
func (s *Server) apiSync(w http.ResponseWriter, r *http.Request, u account.User, _ account.Session) {
	var req syncRequest
	body := http.MaxBytesReader(w, r.Body, maxSyncBody)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			apiError(w, http.StatusRequestEntityTooLarge, "sync request too large; send fewer runs at a time")
			return
		}
		apiError(w, http.StatusBadRequest, "malformed sync request")
		return
	}
	if req.Account != "" {
		if want, err := account.NormalizeEmail(req.Account); err != nil || want != u.Email {
			apiError(w, http.StatusConflict, "account mismatch")
			return
		}
	}
	if req.Cursor < 0 {
		apiError(w, http.StatusBadRequest, "cursor must not be negative")
		return
	}
	pushed := 0
	for _, raws := range req.Push {
		pushed += len(raws)
	}
	if pushed > maxPush || len(req.Deleted) > maxPush {
		apiError(w, http.StatusBadRequest, fmt.Sprintf("send at most %d records and %d deletions per request", maxPush, maxPush))
		return
	}
	resp := syncResponse{Records: map[string][]json.RawMessage{}, Deleted: []history.Ref{}, Rejected: []rejected{}}
	var records []history.Record
	for kind, raws := range req.Push {
		for _, raw := range raws {
			id, err := history.CheckRecord(kind, raw)
			if err != nil {
				resp.Rejected = append(resp.Rejected, rejected{Kind: kind, ID: id, Reason: err.Error()})
				continue
			}
			records = append(records, history.Record{Kind: kind, ID: id, Data: raw})
		}
	}
	if err := s.history.Push(r.Context(), u.ID, records, req.Deleted); err != nil {
		s.serverError(w, err)
		return
	}
	changes, next, more, err := s.history.Pull(r.Context(), u.ID, req.Cursor, pullLimit, pullBytes)
	if err != nil {
		s.serverError(w, err)
		return
	}
	for _, k := range history.Kinds {
		resp.Records[k] = []json.RawMessage{}
	}
	for _, c := range changes {
		if c.Data == nil {
			resp.Deleted = append(resp.Deleted, history.Ref{Kind: c.Kind, ID: c.ID})
		} else {
			resp.Records[c.Kind] = append(resp.Records[c.Kind], c.Data)
		}
	}
	resp.Cursor, resp.More = next, more
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) registerAPI(handle handleFunc) {
	handle("GET /api/me", s.requireAPIUser(s.apiMe))
	handle("POST /api/token", http.HandlerFunc(s.apiToken))
	handle("DELETE /api/token", s.requireAPIUser(s.apiTokenDelete))
	handle("POST /api/sync", s.requireAPIUser(s.apiSync))
}
