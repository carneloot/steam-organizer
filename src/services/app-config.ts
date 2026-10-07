import { Context, type Redacted, Schema } from 'effect';

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
	'ConfigurationError',
	{
		message: Schema.String,
	},
) {}

export class AppConfig extends Context.Service<
	AppConfig,
	{
		readonly jevApiKey: Redacted.Redacted<string> | null;
		readonly steamApiKey: Redacted.Redacted<string> | null;
	}
>()('steam-categorizer/AppConfig') {}
