
import requests

API_KEY = "PKZ5DGHAYJYCKNVDIOE5QU3J7E"
SECRET_KEY = "Bw3yiDa2SjCgScLgZC1pgRmoMuP3gHy44wy2ESXGLu7v"

url = "https://data.alpaca.markets/v2/stocks/TSLA/trades/latest"

response = requests.get(
    url,
    headers={
        "APCA-API-KEY-ID": API_KEY,
        "APCA-API-SECRET-KEY": SECRET_KEY
    },
    params={"feed": "iex"},
    timeout=10
)

print(response.status_code)
print(response.json())
