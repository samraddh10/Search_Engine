import app from "./api/server";
import { config } from "./config";

app.listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT}`);
});
