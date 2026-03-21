# Use the official Ruby image as the base image
FROM ruby:3.4.1-slim-bullseye

# Set environment variables for Rails
ENV RAILS_ENV=production \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_PATH="/bundle" \
    PORT=3000 \
    SECRET_KEY_BASE_DUMMY=1

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
    build-essential \
    libpq-dev \
    nodejs \
    postgresql-client \
    tzdata \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy Gemfile and Gemfile.lock and install dependencies
COPY Gemfile Gemfile.lock ./
RUN bundle install

# Copy the rest of the application code
COPY . .

# Precompile assets (if you have any)
# If you are using importmap-rails, you might not need this step for JS,
# but CSS assets might still need precompilation.
# If you don't have any assets to precompile, you can remove or comment out this line.
RUN SECRET_KEY_BASE=dummy bundle exec rails assets:precompile

# Expose the port Rails runs on
EXPOSE 3000

# Command to run the Rails server
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
