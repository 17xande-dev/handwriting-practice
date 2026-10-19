package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// api sends a JSON request with a bearer token, a cookie, or neither.
func (s *testServer) api(t *testing.T, method, target, body, token, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
	}
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	return rec
}

// deviceToken signs in the way the iPad app does.
func (s *testServer) deviceToken(t *testing.T, email, password string) string {
	t.Helper()
	rec := s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":%q,"password":%q,"label":"iPad"}`, email, password), "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("token: %d %s", rec.Code, rec.Body)
	}
	var resp struct{ Token, Email string }
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Token == "" || resp.Email != email {
		t.Fatalf("token response %s", rec.Body)
	}
	return resp.Token
}

type syncResult struct {
	Cursor   int64                        `json:"cursor"`
	Records  map[string][]json.RawMessage `json:"records"`
	Deleted  []struct{ Kind, ID string }  `json:"deleted"`
	More     bool                         `json:"more"`
	Rejected []struct{ Kind, ID, Reason string }
}

func (s *testServer) sync(t *testing.T, body, token, cookie string) syncResult {
	t.Helper()
	rec := s.api(t, "POST", "/api/sync", body, token, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("sync: %d %s", rec.Code, rec.Body)
	}
	var res syncResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func runJSON(id string) string { return fmt.Sprintf(`{"id":%q,"ts":1700000000000,"accuracy":0.9}`, id) }

// The iPad and the browser are the same account: what one pushes, the other
// pulls, whichever way each authenticates.
func TestSyncBetweenDeviceAndBrowser(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	cookie := s.signIn(t, "a@x.com", testPassword)

	pushed := s.sync(t, `{"cursor":0,"push":{"ink":[`+runJSON("s1")+`],"check":[`+runJSON("r1")+`]}}`, token, "")
	if len(pushed.Rejected) != 0 {
		t.Fatalf("rejected: %+v", pushed.Rejected)
	}
	got := s.sync(t, `{"cursor":0}`, "", cookie)
	if len(got.Records["ink"]) != 1 || len(got.Records["check"]) != 1 {
		t.Fatalf("browser pulled %+v", got.Records)
	}
	// The run comes back exactly as pushed: the server stores the app's JSON.
	if string(got.Records["ink"][0]) != runJSON("s1") {
		t.Errorf("record changed in transit: %s", got.Records["ink"][0])
	}
	// Nothing new after the cursor.
	if again := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, got.Cursor), "", cookie); len(again.Records["ink"])+len(again.Records["check"]) != 0 {
		t.Error("records repeated past the cursor")
	}

	// The browser deletes the ink record; the device learns of it.
	s.sync(t, `{"cursor":0,"deleted":[{"kind":"ink","id":"s1"}]}`, "", cookie)
	dev := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, pushed.Cursor), token, "")
	if len(dev.Deleted) != 1 || dev.Deleted[0].ID != "s1" {
		t.Fatalf("device did not learn of the deletion: %+v", dev)
	}
	// And a stale device re-pushing it does not bring it back.
	again := s.sync(t, `{"cursor":0,"push":{"ink":[`+runJSON("s1")+`]}}`, token, "")
	if len(again.Records["ink"]) != 0 {
		t.Error("deleted run came back")
	}
}

// Every response is arrays, never null, so clients can iterate blindly.
func TestSyncEmptyResponseShape(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	rec := s.api(t, "POST", "/api/sync", `{"cursor":0}`, token, "")
	want := `{"cursor":0,"records":{"check":[],"ink":[],"prefs":[],"strokes":[]},"deleted":[],"more":false,"rejected":[]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

// A bad run is reported, not fatal: the rest of the push still lands, and
// the client learns to stop resending it.
func TestSyncRejectsBadRecordsIndividually(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	res := s.sync(t, `{"cursor":0,"push":{"check":[`+runJSON("ok")+`,{"id":"nots"}],"chord":[`+runJSON("x")+`]}}`, token, "")
	if len(res.Rejected) != 2 {
		t.Fatalf("rejected %+v", res.Rejected)
	}
	if len(res.Records["check"]) != 1 {
		t.Errorf("good record not stored: %+v", res.Records)
	}
}

func TestSyncBadRequests(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	for name, body := range map[string]string{
		"not json":        `nope`,
		"negative cursor": `{"cursor":-1}`,
		"wrong type":      `{"cursor":"0"}`,
	} {
		if rec := s.api(t, "POST", "/api/sync", body, token, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	huge := `{"cursor":0,"push":{"check":["` + strings.Repeat("x", maxSyncBody) + `"]}}`
	if rec := s.api(t, "POST", "/api/sync", huge, token, ""); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized: %d", rec.Code)
	}
}

// One user's history is never reachable by another's credentials.
func TestSyncIsPerUser(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	s.addUser(t, "b@x.com", false)
	a := s.deviceToken(t, "a@x.com", testPassword)
	b := s.deviceToken(t, "b@x.com", testPassword)
	s.sync(t, `{"cursor":0,"push":{"check":[`+runJSON("r1")+`]}}`, a, "")
	if res := s.sync(t, `{"cursor":0}`, b, ""); len(res.Records["check"]) != 0 {
		t.Fatal("b pulled a's run")
	}
}

func TestSyncPaginates(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	// A push is capped at maxPush records, so build the history in two requests.
	push := func(from, to int) {
		var runs []string
		for i := from; i < to; i++ {
			runs = append(runs, runJSON(fmt.Sprint("r", i)))
		}
		if res := s.sync(t, `{"cursor":0,"push":{"check":[`+strings.Join(runs, ",")+`]}}`, token, ""); len(res.Rejected) != 0 {
			t.Fatalf("rejected %+v", res.Rejected)
		}
	}
	push(0, 500)
	push(500, pullLimit+5)
	first := s.sync(t, `{"cursor":0}`, token, "")
	if !first.More || len(first.Records["check"]) != pullLimit {
		t.Fatalf("first page: %d more=%v", len(first.Records["check"]), first.More)
	}
	second := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, first.Cursor), token, "")
	if second.More || len(second.Records["check"]) != 5 {
		t.Fatalf("second page: %d more=%v", len(second.Records["check"]), second.More)
	}
}

func TestAPIRefusesAnonymous(t *testing.T) {
	s := newAccountServer(t)
	for _, route := range []string{"GET /api/me", "POST /api/sync", "DELETE /api/token"} {
		method, path, _ := strings.Cut(route, " ")
		for _, token := range []string{"", "made-up"} {
			rec := s.api(t, method, path, `{}`, token, "")
			if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"error"`) {
				t.Errorf("%s token=%q: %d %s", route, token, rec.Code, rec.Body)
			}
		}
	}
}

// The token endpoint is the app's sign-in form: same single failure
// message, same rate limit.
func TestTokenSignIn(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	for _, body := range []string{`{"email":"a@x.com","password":"wrong password!"}`, `{"email":"no@x.com","password":"whatever it is"}`} {
		rec := s.api(t, "POST", "/api/token", body, "", "")
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), loginFailed) {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body)
		}
	}
	for range 5 {
		s.api(t, "POST", "/api/token", `{"email":"a@x.com","password":"wrong password!"}`, "", "")
	}
	if rec := s.api(t, "POST", "/api/token", `{"email":"a@x.com","password":"`+testPassword+`"}`, "", ""); rec.Code != http.StatusTooManyRequests {
		t.Errorf("not rate limited: %d", rec.Code)
	}
}

// Signing the app out kills its token, and the device shows on the account
// page until then, labelled as the app named it.
func TestTokenSignOut(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	cookie := s.signIn(t, "a@x.com", testPassword)
	if !strings.Contains(s.do(t, "GET", "/account", nil, cookie).Body.String(), "iPad") {
		t.Error("device missing from the account page")
	}
	if rec := s.api(t, "GET", "/api/me", "", token, ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), "a@x.com") {
		t.Fatalf("me: %d %s", rec.Code, rec.Body)
	}
	if rec := s.api(t, "DELETE", "/api/token", "", token, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := s.api(t, "GET", "/api/me", "", token, ""); rec.Code != http.StatusUnauthorized {
		t.Error("token works after sign-out")
	}
	// The browser session is untouched.
	if rec := s.api(t, "GET", "/api/me", "", "", cookie); rec.Code != 200 {
		t.Error("app sign-out ended the browser session")
	}
}

// An account the admin creates signs in on both the web and the app with
// the password shown once.
func TestCreatedAccountWorksForWebAndApp(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	cookie := s.signIn(t, "admin@x.com", testPassword)
	rec := s.do(t, "POST", "/admin/users", url.Values{"email": {"p@x.com"}}, cookie)
	pw := shownPassword.FindStringSubmatch(rec.Body.String())[1]
	s.signIn(t, "p@x.com", pw)
	s.deviceToken(t, "p@x.com", pw)
}

// A database fault while checking a token is a 500, not a 401: clients take
// 401 to mean the token is dead and throw it away.
func TestAuthFaultIsNotSignedOut(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	s.db.Close()
	if rec := s.api(t, "GET", "/api/me", "", token, ""); rec.Code != http.StatusInternalServerError {
		t.Errorf("auth fault: %d, want 500", rec.Code)
	}
	if rec := s.api(t, "GET", "/api/me", "", "", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("no credentials: %d, want 401", rec.Code)
	}
}

// A disabled account's app token stops working at once.
func TestDisabledUserTokenRefused(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	s.accounts.SetDisabled(t.Context(), u.ID, true)
	if rec := s.api(t, "POST", "/api/sync", `{"cursor":0}`, token, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("disabled user synced: %d", rec.Code)
	}
}

// The browser's sync is a same-origin fetch; a cross-site one is refused
// before it can push into the visitor's account.
func TestCrossSiteSyncRefused(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	r := httptest.NewRequest("POST", "/api/sync", strings.NewReader(`{"cursor":0}`))
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Errorf("cross-site sync: %d", rec.Code)
	}
}

// An ink record carries the quantized strokes of one attempt, so it is the
// record most likely to be big. 64 KB is the limit for every kind, and a
// refused one is reported, not stored.
func TestSyncInkRecordSizeLimit(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	ink := func(id string, n int) string {
		return fmt.Sprintf(`{"id":%q,"ts":1700000000000,"check":"c1","strokes":"%s"}`, id, strings.Repeat("x", n))
	}
	res := s.sync(t, `{"cursor":0,"push":{"ink":[`+ink("small", 60<<10)+`,`+ink("big", 65<<10)+`]}}`, token, "")
	if len(res.Records["ink"]) != 1 || len(res.Rejected) != 1 || res.Rejected[0].Kind != "ink" || res.Rejected[0].ID != "big" {
		t.Fatalf("records %d, rejected %+v", len(res.Records["ink"]), res.Rejected)
	}
}

func TestSyncAccountMismatch(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	s.addUser(t, "b@x.com", false)
	cookie := s.signIn(t, "b@x.com", testPassword)
	// A browser whose cookie is b's, syncing as a: nothing may be stored or returned.
	rec := s.api(t, "POST", "/api/sync", `{"account":"a@x.com","cursor":0,"push":{"check":[`+runJSON("mine")+`]}}`, "", cookie)
	if rec.Code != http.StatusConflict || strings.TrimSpace(rec.Body.String()) != `{"error":"account mismatch"}` {
		t.Fatalf("mismatch: %d %s", rec.Code, rec.Body)
	}
	if got := s.sync(t, `{"cursor":0}`, "", cookie); len(got.Records["check"]) != 0 {
		t.Error("a mismatched push was stored under the session's account")
	}
	// The right account, in any case or padding, and an omitted field, both work.
	for _, body := range []string{`{"account":"b@x.com","cursor":0}`, `{"account":" B@X.com ","cursor":0}`, `{"cursor":0}`} {
		if rec := s.api(t, "POST", "/api/sync", body, "", cookie); rec.Code != http.StatusOK {
			t.Errorf("%s: %d", body, rec.Code)
		}
	}
	// Junk is a mismatch, not a pass.
	if rec := s.api(t, "POST", "/api/sync", `{"account":"not an email","cursor":0}`, "", cookie); rec.Code != http.StatusConflict {
		t.Errorf("junk account: %d", rec.Code)
	}
}

func TestSyncRejectedRecordsCarryTheirID(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	res := s.sync(t, `{"cursor":0,"push":{"check":[
		{"id":"no-ts"},
		{"id":"clash","ts":1,"ID":"x"},
		{"id":"zero","ts":0},
		{"id":"`+strings.Repeat("a", 70)+`","ts":1}]}}`, token, "")
	got := map[string]string{}
	for _, r := range res.Rejected {
		got[r.ID] = r.Reason
	}
	for _, id := range []string{"no-ts", "clash", "zero", strings.Repeat("a", 70)} {
		if got[id] == "" {
			t.Errorf("rejection for %.10q lacks its id: %+v", id, res.Rejected)
		}
	}
}

func TestSyncPushCaps(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	recs := func(n int) string {
		var r []string
		for i := range n {
			r = append(r, runJSON(fmt.Sprint("c", i)))
		}
		return strings.Join(r, ",")
	}
	// 600 + 401 across two kinds is over 1000 in total.
	over := `{"push":{"check":[` + recs(600) + `],"ink":[` + strings.ReplaceAll(recs(401), `"c`, `"i`) + `]}}`
	if rec := s.api(t, "POST", "/api/sync", over, token, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("1001 records: %d", rec.Code)
	}
	var dels []string
	for i := range 1001 {
		dels = append(dels, fmt.Sprintf(`{"kind":"check","id":"d%d"}`, i))
	}
	if rec := s.api(t, "POST", "/api/sync", `{"deleted":[`+strings.Join(dels, ",")+`]}`, token, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("1001 deletions: %d", rec.Code)
	}
	// Exactly 1000 of each is fine.
	ok := `{"push":{"check":[` + recs(1000) + `]},"deleted":[` + strings.Join(dels[:1000], ",") + `]}`
	if rec := s.api(t, "POST", "/api/sync", ok, token, ""); rec.Code != http.StatusOK {
		t.Errorf("1000 and 1000: %d %.100s", rec.Code, rec.Body)
	}
	// And nothing from the refused requests was stored.
	got := s.sync(t, `{"cursor":0}`, token, "")
	if len(got.Records["ink"]) != 0 {
		t.Errorf("a refused push stored %d ink records", len(got.Records["ink"]))
	}
}

// A response is capped by bytes as well as by records, and says so with more.
func TestSyncPullPagesByBytes(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	pad := strings.Repeat("x", 50<<10)
	var runs []string
	for i := range 100 { // ~5 MB of data
		runs = append(runs, fmt.Sprintf(`{"id":"r%d","ts":1,"pad":%q}`, i, pad))
	}
	for i := 0; i < 100; i += 50 {
		if res := s.sync(t, `{"push":{"check":[`+strings.Join(runs[i:i+50], ",")+`]}}`, token, ""); len(res.Rejected) != 0 {
			t.Fatalf("rejected %+v", res.Rejected)
		}
	}
	first := s.sync(t, `{"cursor":0}`, token, "")
	if !first.More || len(first.Records["check"]) >= 100 || len(first.Records["check"]) < 50 {
		t.Fatalf("first page: %d records, more=%v", len(first.Records["check"]), first.More)
	}
	n := 0
	for _, r := range first.Records["check"] {
		n += len(r)
	}
	if n > pullBytes {
		t.Errorf("page carries %d bytes of data, cap is %d", n, pullBytes)
	}
	cursor, total := first.Cursor, len(first.Records["check"])
	for more := true; more; {
		res := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, cursor), token, "")
		cursor, total, more = res.Cursor, total+len(res.Records["check"]), res.More
	}
	if total != 100 {
		t.Errorf("paged through %d of 100 records", total)
	}
}

// A strokes record is a person's definitions for one font, edited in place: a newer ts replaces the
// stored one and reaches the other devices, an older one is ignored, and a deletion still wins.
func TestSyncStrokesRecords(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	rec := func(ts int, note string) string {
		return fmt.Sprintf(`{"id":"strokes-italic","ts":%d,"v":1,"model":"italic","glyphs":{"a":{"note":%q}}}`, ts, note)
	}
	first := s.sync(t, `{"cursor":0,"push":{"strokes":[`+rec(100, "one")+`]}}`, token, "")
	if len(first.Records["strokes"]) != 1 || len(first.Rejected) != 0 {
		t.Fatalf("strokes: %d records, rejected %+v", len(first.Records["strokes"]), first.Rejected)
	}
	// Another device pushes a newer edit, then a stale one.
	second := s.sync(t, fmt.Sprintf(`{"cursor":%d,"push":{"strokes":[%s]}}`, first.Cursor, rec(200, "two")), token, "")
	if len(second.Records["strokes"]) != 1 || string(second.Records["strokes"][0]) != rec(200, "two") {
		t.Fatalf("newer edit not returned: %s", second.Records["strokes"])
	}
	third := s.sync(t, fmt.Sprintf(`{"cursor":%d,"push":{"strokes":[%s]}}`, second.Cursor, rec(150, "stale")), token, "")
	if len(third.Records["strokes"]) != 0 {
		t.Fatalf("a stale edit replaced the record: %s", third.Records["strokes"])
	}
	all := s.sync(t, `{"cursor":0}`, token, "")
	if len(all.Records["strokes"]) != 1 || string(all.Records["strokes"][0]) != rec(200, "two") {
		t.Fatalf("stored record: %s", all.Records["strokes"])
	}
	// Deleted, it stays deleted.
	s.sync(t, `{"cursor":0,"deleted":[{"kind":"strokes","id":"strokes-italic"}]}`, token, "")
	back := s.sync(t, `{"cursor":0,"push":{"strokes":[`+rec(300, "three")+`]}}`, token, "")
	if len(back.Records["strokes"]) != 0 {
		t.Fatal("a deleted strokes record came back")
	}
}

// A prefs record (the favourite fonts) is edited in place: a newer ts replaces it, a stale one does not,
// and a deletion stays.
func TestSyncPrefsRecords(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	rec := func(ts int, fam string) string {
		return fmt.Sprintf(`{"id":"prefs-favourites","ts":%d,"v":1,"favourites":[{"id":"google:%s","kind":"google","family":%q}]}`, ts, fam, fam)
	}
	first := s.sync(t, `{"cursor":0,"push":{"prefs":[`+rec(100, "Caveat")+`]}}`, token, "")
	if len(first.Records["prefs"]) != 1 || len(first.Rejected) != 0 {
		t.Fatalf("prefs: %d records, rejected %+v", len(first.Records["prefs"]), first.Rejected)
	}
	second := s.sync(t, fmt.Sprintf(`{"cursor":%d,"push":{"prefs":[%s]}}`, first.Cursor, rec(200, "Pacifico")), token, "")
	if len(second.Records["prefs"]) != 1 || string(second.Records["prefs"][0]) != rec(200, "Pacifico") {
		t.Fatalf("newer edit not returned: %s", second.Records["prefs"])
	}
	third := s.sync(t, fmt.Sprintf(`{"cursor":%d,"push":{"prefs":[%s]}}`, second.Cursor, rec(150, "Stale")), token, "")
	if len(third.Records["prefs"]) != 0 {
		t.Fatalf("a stale edit replaced the record: %s", third.Records["prefs"])
	}
	s.sync(t, `{"cursor":0,"deleted":[{"kind":"prefs","id":"prefs-favourites"}]}`, token, "")
	back := s.sync(t, `{"cursor":0,"push":{"prefs":[`+rec(300, "Again")+`]}}`, token, "")
	if len(back.Records["prefs"]) != 0 {
		t.Fatal("a deleted prefs record came back")
	}
}
