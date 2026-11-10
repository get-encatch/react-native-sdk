// Calls the mock's control API from a flow. Env: MOCK_URL, MOCK_PATH, MOCK_BODY (JSON).
const res = http.post(MOCK_URL + '/__mock/' + MOCK_PATH, {
  headers: { 'Content-Type': 'application/json' },
  body: typeof MOCK_BODY === 'undefined' ? '{}' : MOCK_BODY,
});
if (!res.ok) throw new Error('mock ' + MOCK_PATH + ' failed: ' + res.status);
